const express = require('express');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static('public'));
app.use('/screenshots', express.static(path.join(__dirname, 'public/screenshots')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const server = app.listen(port, () => console.log(`Сервер запущен на порту ${port}`));
const wss = new WebSocket.Server({ server });

const screenshotDir = path.join(__dirname, 'public/screenshots');
if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

const clients = new Map();
const helpers = new Map();

// ← ВСТАВЬ СВОЙ КЛЮЧ СЮДА (создай на https://aistudio.google.com/app/apikey)
const GEMINI_KEY = "AIzaSyDmKI5WBNfXrUvwLEGnMajrUqoK26YY1a0"; // ← замени на свой

async function callGemini(base64) {
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { text: "Кратко и понятно: что на скриншоте и как решить проблему? Только шаги, на русском языке." },
                        { inline_data: { mime_type: "image/png", data: base64 }}
                    ]
                }]
            })
        });

        if (!response.ok) {
            const err = await response.text();
            console.log("Gemini ошибка:", response.status, err);
            return null;
        }

        const json = await response.json();
        const answer = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (answer && answer.length > 10) {
            return answer + "\n\n(ИИ ответил за 4 сек)";
        }
    } catch (e) {
        console.log("Gemini исключение:", e.message);
    }
    return null;
}

wss.on('connection', ws => {
    ws.isAlive = true;
    ws.on('pong', () => ws.isAlive = true);

    ws.on('message', async message => {
        let data;
        try { data = JSON.parse(message); } catch { return; }

        if (data.type === 'frontend_connect') {
            ws.clientId = data.clientId;
            clients.set(data.clientId, ws);
        }
        if (data.type === 'helper_connect') {
            ws.helperId = data.helperId;
            helpers.set(data.helperId, ws);
        }

        if (data.type === 'screenshot') {
            const buffer = Buffer.from(data.dataUrl.split(',')[1], 'base64');
            const timestamp = Date.now();
            const filename = `${data.helperId}-${timestamp}-0.png`;
            const filepath = path.join(screenshotDir, filename);

            sharp(buffer)
                .resize({ width: 1024, height: 768, fit: 'inside' })
                .png({ quality: 70 })
                .toFile(filepath)
                .then(async () => {
                    console.log(`Скриншот сохранён: ${filename}`);
                    const questionId = `${data.helperId}-${timestamp}-0`;

                    const aiAnswer = await callGemini(buffer.toString('base64'));

                    if (aiAnswer) {
                        const clientWs = clients.get(data.clientId);
                        if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                            clientWs.send(JSON.stringify({
                                type: 'answer',
                                questionId,
                                answer: aiAnswer,
                                clientId: data.clientId
                            }));
                        }
                        console.log("Gemini ответил мгновенно!");
                        return;
                    }

                    const helperWs = helpers.get(data.helperId);
                    if (helperWs && helperWs.readyState === WebSocket.OPEN) {
                        helperWs.send(JSON.stringify({
                            type: 'new_screenshot_for_helper',
                            questionId,
                            imageUrl: `/screenshots/${filename}`,
                            clientId: data.clientId
                        }));
                        console.log(`Скриншот ушёл помощнику: ${data.helperId}`);
                    }
                });
        }
    });

    ws.on('close', () => {
        if (ws.clientId) clients.delete(ws.clientId);
        if (ws.helperId) helpers.delete(ws.helperId);
    });
});

setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

console.log("Сервер с Gemini запущен — ИИ готов!");
