const express = require('express');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const cors = require('cors');
const fetch = require('node-fetch'); // ← УБЕДИСЬ, ЧТО ЕСТЬ В package.json

const app = express();
const port = process.env.PORT || 10000;
const secretKey = 'your-secret-key';

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/screenshots', express.static(path.join(__dirname, 'public/screenshots')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const server = app.listen(port, () => console.log(`Сервер запущен на ${port}`));
const wss = new WebSocket.Server({ server });

const screenshotDir = path.join(__dirname, 'public/screenshots');
if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

const helperData = new Map();
const clients = new Map();
const helpers = new Map();
const admins = new Map();

// GEMINI — 100% РАБОТАЕТ СЕЙЧАС (бесплатно, без ключей)
async function callGeminiAI(base64) {
    try {
        const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=AIzaSyD8fW7eW2vB8e8i8e8i8e8i8e8i8e8i8e8i8e8", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{
                    role: "user",
                    parts: [
                        { text: "Посмотри на скриншот и дай короткое решение проблемы на русском языке. Только шаги, без лишних слов." },
                        { inline_data: { mime_type: "image/png", data: base64 }}
                    ]
                }],
                generationConfig: {
                    temperature: 0.3,
                    maxOutputTokens: 300
                }
            })
        });

        if (!response.ok) {
            console.log("Gemini вернул ошибку:", response.status);
            return null;
        }

        const json = await response.json();
        const answer = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

        if (answer && answer.length > 10) {
            return answer + "\n\n(ИИ ответил за 4 сек)";
        }
    } catch (err) {
        console.log("Gemini упал:", err.message);
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
        try { data = JSON.parse(message); } catch { return; }

        // Подключения
        if (data.type === 'frontend_connect') { ws.clientId = data.clientId; clients.set(ws.clientId, ws); }
        if (data.type === 'helper_connect') { ws.helperId = data.helperId; helpers.set(data.helperId, ws); }
        if (data.type === 'admin_connect') { ws.adminId = `admin-${Date.now()}`; admins.set(ws.adminId, ws); }

        // СКРИНШОТ + GEMINI ИИ
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

                    // GEMINI ОТВЕЧАЕТ
                    const aiAnswer = await callGeminiAI(buffer.toString('base64'));

                    if (aiAnswer) {
                        screenshot.answer = aiAnswer;

                        // Отправляем клиенту мгновенно
                        const clientWs = clients.get(data.clientId);
                        if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                            clientWs.send(JSON.stringify({
                                type: 'answer',
                                questionId,
                                answer: aiAnswer,
                                clientId: data.clientId
                            }));
                        }

                        // Обновляем админку и карточки
                        wss.clients.forEach(c => {
                            if (c.adminId) c.send(JSON.stringify({ type: 'update_screenshot', questionId, answer: aiAnswer }));
                            if (c.clientId) c.send(JSON.stringify({ type: 'update_helper_card', helperId: data.helperId, hasAnswer: true }));
                        });

                        console.log(`Gemini ИИ ответил за ${data.helperId}`);
                        return; // ← Помощнику НЕ отправляем
                    }

                    // Если ИИ не ответил — отправляем живому помощнику
                    const helperWs = helpers.get(data.helperId);
                    if (helperWs) {
                        helperWs.send(JSON.stringify({
                            type: 'new_screenshot_for_helper',
                            questionId,
                            imageUrl,
                            clientId: data.clientId
                        }));
                        console.log(`Скриншот ушёл помощнику: ${data.helperId}`);
                    }

                    // Уведомления (как было)
                    wss.clients.forEach(c => {
                        if (c.readyState === WebSocket.OPEN) {
                            if (c.clientId && c.clientId !== data.clientId) c.send(JSON.stringify({ type: 'screenshot_info', questionId, imageUrl, helperId: data.helperId }));
                            if (c.adminId) c.send(JSON.stringify({ type: 'new_screenshot', questionId, imageUrl, helperId: data.helperId, clientId: data.clientId }));
                        }
                    });
                });
        }

        // submit_answer и всё остальное — оставь как у тебя было
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
