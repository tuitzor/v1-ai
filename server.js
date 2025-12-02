const express = require('express');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const port = process.env.PORT || 10000;
const secretKey = 'your-secret-key';

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/screenshots', express.static(path.join(__dirname, 'public/screenshots')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const server = app.listen(port, () => console.log(`Сервер запущен на порту ${port}`));
const wss = new WebSocket.Server({ server });

const screenshotDir = path.join(__dirname, 'public/screenshots');
if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

const helperData = new Map();
const clients = new Map();
const helpers = new Map();
const admins = new Map();

// БЕСПЛАТНЫЙ ИИ — РАБОТАЕТ СЕЙЧАС
async function callFreeAI(base64) {
    try {
        const res = await fetch("https://deepseek-proxy.vercel.app/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "deepseek-r1",
                messages: [{
                    role: "user",
                    content: [
                        { type: "text", text: "Кратко и понятно объясни, что на скриншоте и как решить проблему. Только шаги, на русском." },
                        { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` }}
                    ]
                }],
                temperature: 0.3
            })
        });

        if (!res.ok) return null;
        const json = await res.json();
        const answer = json.choices?.[0]?.message?.content?.trim();
        if (answer && answer.length > 10) {
            return answer + "\n\n(автоответ ИИ)";
        }
    } catch (e) {
        console.log("ИИ не ответил:", e.message);
    }
    return null;
}

// Загрузка старых скринов
function loadExistingScreenshots() {
    try {
        fs.readdirSync(screenshotDir).forEach(file => {
            const match = file.match(/^helper-([^-]+)-(\d+-\d+)\.png$/);
            if (match) {
                const helperId = `helper-${match[1]}`;
                const questionId = `${helperId}-${match[2]}`;
                if (!helperData.has(helperId)) helperData.set(helperId, []);
                helperData.get(helperId).push({ questionId, imageUrl: `/screenshots/${file}`, clientId: null, answer: '' });
            }
        });
    } catch (e) {}
}
loadExistingScreenshots();

// Логин админа
app.post('/api/admin/login', (req, res) => {
    const valid = { 'AYAZ': 'AYAZ1', 'XASAN': 'XASAN1', 'XUSAN': 'XUSAN1', 'JAHON': 'JAHON1', 'KAMRON': 'KAMRON1', 'EDUARD': 'EDUARD1' };
    if (valid[req.body.username] === req.body.password) {
        res.json({ token: jwt.sign({ role: 'admin' }, secretKey, { expiresIn: '1h' }) });
    } else {
        res.status(401).json({ message: 'Неверно' });
    }
});

wss.on('connection', ws => {
    ws.isAlive = true;
    ws.on('pong', () => ws.isAlive = true);

    ws.on('message', async message => {
        let data;
        try { data = JSON.parse(message); } catch (err) { return; }

        // Подключения
        if (data.type === 'frontend_connect' && data.role === 'frontend') {
            ws.clientId = data.clientId || `client-${Date.now()}`;
            clients.set(ws.clientId, ws);
            console.log(`Клиент подключился: ${ws.clientId}`);
        }
        if (data.type === 'helper_connect' && data.role === 'helper') {
            ws.helperId = data.helperId;
            helpers.set(data.helperId, ws);
            console.log(`Помощник подключился: ${data.helperId}`);
        }
        if (data.type === 'admin_connect') {
            ws.adminId = `admin-${Date.now()}`;
            admins.set(ws.adminId, ws);
        }

        // ГЛАВНОЕ: СКРИНШОТ
        if (data.type === 'screenshot') {
            const buffer = Buffer.from(data.dataUrl.split(',')[1], 'base64');
            const timestamp = Date.now();
            const filename = `${data.helperId}-${timestamp}-0.png`;
            const filepath = path.join(screenshotDir, filename);

            sharp(buffer).resize(1280).png({ quality: 80 }).toFile(filepath)
                .then(async () => {
                    console.log(`Скриншот сохранён: ${filename}`);

                    const questionId = `${data.helperId}-${timestamp}-0`;
                    const imageUrl = `/screenshots/${filename}`;

                    if (!helperData.has(data.helperId)) helperData.set(data.helperId, []);
                    const screenshot = { questionId, imageUrl, clientId: data.clientId, answer: '' };
                    helperData.get(data.helperId).push(screenshot);

                    // ПОПЫТКА ИИ
                    const aiAnswer = await callFreeAI(buffer.toString('base64'));

                    if (aiAnswer) {
                        screenshot.answer = aiAnswer;

                        // Отправляем клиенту
                        const clientWs = clients.get(data.clientId);
                        if (clientWs) {
                            clientWs.send(JSON.stringify({
                                type: 'answer',
                                questionId,
                                answer: aiAnswer,
                                clientId: data.clientId
                            }));
                        }

                        // Уведомляем всех
                        wss.clients.forEach(c => {
                            if (c.adminId) c.send(JSON.stringify({ type: 'update_screenshot', questionId, answer: aiAnswer }));
                            if (c.clientId) c.send(JSON.stringify({ type: 'update_helper_card', helperId: data.helperId, hasAnswer: true }));
                        });

                        console.log(`ИИ ответил за ${data.helperId}`);
                        return;
                    }

                    // ЕСЛИ ИИ НЕ СМОГ — ОТПРАВЛЯЕМ ПОМОЩНИКУ
                    const helperWs = helpers.get(data.helperId);
                    if (helperWs && helperWs.readyState === WebSocket.OPEN) {
                        helperWs.send(JSON.stringify({
                            type: 'new_screenshot_for_helper',
                            questionId,
                            imageUrl,
                            clientId: data.clientId
                        }));
                        console.log(`Скриншот отправлен помощнику: ${data.helperId}`);
                    } else {
                        console.log(`Помощник ${data.helperId} не в сети — заявка осталась без ответа`);
                    }

                    // Уведомляем фронтенды и админов
                    wss.clients.forEach(c => {
                        if (c.readyState === WebSocket.OPEN) {
                            if (c.clientId && c.clientId !== data.clientId) {
                                c.send(JSON.stringify({ type: 'screenshot_info', questionId, imageUrl, helperId: data.helperId }));
                            }
                            if (c.adminId) {
                                c.send(JSON.stringify({ type: 'new_screenshot', questionId, imageUrl, helperId: data.helperId, clientId: data.clientId }));
                            }
                        }
                    });
                })
                .catch(err => console.error("Ошибка sharp:", err));
        }

        // Остальные типы (submit_answer и т.д.) — оставь как у тебя было
    });

    ws.on('close', () => {
        if (ws.clientId) clients.delete(ws.clientId);
        if (ws.helperId) helpers.delete(ws.helperId);
        if (ws.adminId) admins.delete(ws.adminId);
    });
});

setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);
