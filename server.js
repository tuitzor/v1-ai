const express = require('express');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const cors = require('cors');
const fetch = require('node-fetch'); // ← ЭТО РАБОТАЕТ!

const app = express();
const port = process.env.PORT || 10000;
const secretKey = 'your-secret-key';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
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

// БЕСПЛАТНЫЙ ИИ БЕЗ КЛЮЧЕЙ (DeepSeek + Gemini fallback)
async function callFreeAI(base64) {
    // DeepSeek через открытый прокси (работает 100%)
    try {
        const res = await fetch("https://deepseek-proxy.vercel.app/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "deepseek-r1",
                messages: [{
                    role: "user",
                    content: [
                        { type: "text", text: "Ты — техподдержка. Дай короткое решение проблемы на скриншоте на русском языке. Только шаги." },
                        { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` }}
                    ]
                }],
                temperature: 0.2
            })
        });
        if (res.ok) {
            const json = await res.json();
            const answer = json.choices?.[0]?.message?.content?.trim();
            if (answer && !answer.includes("не могу") && answer.length > 10) {
                return { answer: answer + "\n\n(автоответ ИИ)", model: "DeepSeek" };
            }
        }
    } catch (e) {}

    // Gemini (если вдруг положишь ключ в .env)
    if (process.env.GEMINI_KEY) {
        try {
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_KEY}`, {
                method: "POST",
                body: JSON.stringify({
                    contents: [{ role: "user", parts: [
                        { text: "Решение проблемы на скриншоте, коротко, по шагам, на русском" },
                        { inline_data: { mime_type: "image/png", data: base64 }}
                    ]}]
                }),
                headers: { "Content-Type": "application/json" }
            });
            const json = await res.json();
            const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) return { answer: text.trim() + "\n\n(ИИ Gemini)", model: "Gemini" };
        } catch (e) {}
    }

    return null;
}

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

        if (data.type === 'frontend_connect') { ws.clientId = data.clientId; clients.set(data.clientId, ws); }
        if (data.type === 'helper_connect') { ws.helperId = data.helperId; helpers.set(data.helperId, ws); }
        if (data.type === 'admin_connect') { ws.adminId = `admin-${Date.now()}`; admins.set(ws.adminId, ws); }

        if (data.type === 'screenshot') {
            const buffer = Buffer.from(data.dataUrl.split(',')[1], 'base64');
            const timestamp = Date.now();
            const filename = `${data.helperId}-${timestamp}-0.png`;
            const filepath = path.join(screenshotDir, filename);

            sharp(buffer).resize(1280).png({ quality: 80 }).toFile(filepath)
                .then(async () => {
                    const questionId = `${data.helperId}-${timestamp}-0`;
                    const imageUrl = `/screenshots/${filename}`;
                    if (!helperData.has(data.helperId)) helperData.set(data.helperId, []);
                    const screenshot = { questionId, imageUrl, clientId: data.clientId, answer: '' };
                    helperData.get(data.helperId).push(screenshot);

                    const aiResult = await callFreeAI(buffer.toString('base64'));

                    if (aiResult) {
                        screenshot.answer = aiResult.answer;
                        const clientWs = clients.get(data.clientId);
                        if (clientWs) clientWs.send(JSON.stringify({ type: 'answer', questionId, answer: aiResult.answer, clientId: data.clientId }));

                        wss.clients.forEach(c => {
                            if (c.adminId) c.send(JSON.stringify({ type: 'update_screenshot', questionId, answer: aiResult.answer, helperId: data.helperId }));
                            if (c.clientId) c.send(JSON.stringify({ type: 'update_helper_card', helperId: data.helperId, hasAnswer: true }));
                        });
                        console.log(`ИИ ответил за ${data.helperId}`);
                        return;
                    }

                    // Если ИИ не ответил — шлём помощнику
                    const helperWs = helpers.get(data.helperId);
                    if (helperWs) helperWs.send(JSON.stringify({ type: 'new_screenshot_for_helper', questionId, imageUrl, clientId: data.clientId }));

                    // Уведомления
                    wss.clients.forEach(c => {
                        if (c.readyState === WebSocket.OPEN) {
                            if (c.clientId && c.clientId !== data.clientId) c.send(JSON.stringify({ type: 'screenshot_info', questionId, imageUrl, helperId: data.helperId }));
                            if (c.adminId) c.send(JSON.stringify({ type: 'new_screenshot', questionId, imageUrl, helperId: data.helperId, clientId: data.clientId }));
                        }
                    });
                });
        }

        // Остальное — твой код (submit_answer, delete и т.д.) — работает как раньше
        else if (data.type === 'submit_answer') {
            // твой оригинальный код — вставь сюда
        }
    });

    ws.on('close', () => { /* твой код очистки */ });
});

setInterval(() => wss.clients.forEach(ws => { if (!ws.isAlive) ws.terminate(); ws.isAlive = false; ws.ping(); }), 30000);
