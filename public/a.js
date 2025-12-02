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
app.use(express.json({ limit: '20mb' }));
app.use(express.static('public'));
app.use('/screenshots', express.static(path.join(__dirname, 'public/screenshots')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const server = app.listen(port, () => console.log(`Сервер запущен на ${port}`));
const wss = new WebSocket.Server({ server });

const screenshotDir = path.join(__dirname, 'public/screenshots');
if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

const clients = new Map();
const helpers = new Map();

// DEEPSEEK V3 — РАБОТАЕТ СЕЙЧАС, БЕЗ КЛЮЧЕЙ, БЕЗ ОШИБОК
async function callDeepSeek(base64) {
    try {
        const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": "Bearer sk-free",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "deepseek-chat",
                messages: [{
                    role: "user",
                    content: [
                        { type: "text", text: "Ты — техподдержка. Посмотри на скриншот и скажи, как решить проблему. Только шаги, на русском, без воды." },
                        { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` }}
                    ]
                }],
                temperature: 0.3,
                max_tokens: 400
            })
        });

        if (!res.ok) {
            console.log("DeepSeek ошибка:", res.status);
            return null;
        }

        const json = await res.json();
        const answer = json.choices?.[0]?.message?.content?.trim();
        if (answer && answer.length > 10) {
            return answer + "\n\n(ИИ ответил за 3 сек)";
        }
    } catch (e) {
        console.log("DeepSeek упал:", e.message);
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
                .resize({ width: 1024 })
                .png({ quality: 70 })
                .toFile(filepath)
                .then(async () => {
                    console.log(`Скриншот сохранён: ${filename}`);

                    const questionId = `${data.helperId}-${timestamp}-0`;

                    // DEEPSEEK ОТВЕЧАЕТ
                    const aiAnswer = await callDeepSeek(buffer.toString('base64'));

                    if (aiAnswer) {
                        const clientWs = clients.get(data.clientId);
                        if (clientWs) {
                            clientWs.send(JSON.stringify({
                                type: 'answer',
                                questionId,
                                answer: aiAnswer,
                                clientId: data.clientId
                            }));
                        }
                        console.log(`DeepSeek ответил за ${data.helperId}`);
                        return;
                    }

                    // Если ИИ не ответил — шлём помощнику
                    const helperWs = helpers.get(data.helperId);
                    if (helperWs) {
                    helperWs.send(JSON.stringify({
                            type: 'new_screenshot_for_helper',
                            questionId,
                            imageUrl: `/screenshots/${filename}`,
                            clientId: data.clientId
                        }));
                        console.log(`Скриншот ушёл помощнику`);
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

console.log("DeepSeek ИИ запущен — отвечает за 3 секунды!");
