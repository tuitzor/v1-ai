const express = require('express');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 10000;
const secretKey = 'your-secret-key'; // Replace with a secure key in production

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/screenshots', express.static(path.join(__dirname, 'public/screenshots')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const wss = new WebSocket.Server({ server: app.listen(port, () => {
    console.log(`Сервер запущен на порту: ${port}`);
    console.log(`WebSocket-сервер запущен на ws://localhost:${port}`);
}) });

const screenshotDir = path.join(__dirname, 'public/screenshots');
if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
    console.log('Сервер: Папка для скриншотов создана:', screenshotDir);
}

const helperData = new Map(); // helperId -> [screenshots]
const clients = new Map();    // clientId -> WebSocket
const helpers = new Map();    // helperId -> WebSocket
const admins = new Map();     // adminId -> WebSocket

function loadExistingScreenshots() {
    fs.readdirSync(screenshotDir).forEach(file => {
        const match = file.match(/^helper-([^-]+)-(\d+-\d+)\.png$/);
        if (match) {
            const helperId = `helper-${match[1]}`;
            const questionId = `${helperId}-${match[2]}`;
            if (!helperData.has(helperId)) {
                helperData.set(helperId, []);
            }
            helperData.get(helperId).push({ questionId, imageUrl: `/screenshots/${file}`, clientId: null, answer: '' });
        }
    });
    console.log(`Сервер: Загружено ${helperData.size} помощников с ${Array.from(helperData.values()).reduce((sum, v) => sum + v.length, 0)} скриншотами`);
}

loadExistingScreenshots();

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    const validCredentials = {
        'AYAZ': 'AYAZ1',
        'XASAN': 'XASAN1',
        'XUSAN': 'XUSAN1',
        'JAHON': 'JAHON1',
        'KAMRON': 'KAMRON1',
        'EDUARD': 'EDUARD1'
    };

    if (validCredentials[username] && validCredentials[username] === password) {
        const token = jwt.sign({ username, role: 'admin' }, secretKey, { expiresIn: '1h' });
        res.json({ token });
    } else {
        res.status(401).json({ message: 'Неверное имя пользователя или пароль' });
    }
});

wss.on('connection', (ws) => {
    console.log('Сервер: Новый клиент подключился по WebSocket');
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
        console.log(`Сервер: Получен pong от клиента, helperId: ${ws.helperId || 'unknown'}, clientId: ${ws.clientId || 'unknown'}, adminId: ${ws.adminId || 'unknown'}`);
    });

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
            console.log('Сервер: Получено сообщение по WS:', data);
        } catch (err) {
            console.error('Сервер: Ошибка разбора сообщения:', err);
            return;
        }

        if (data.type === 'frontend_connect' && data.role === 'frontend') {
            ws.clientId = data.clientId || `anonymous-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            clients.set(ws.clientId, ws);
            console.log(`Сервер: Фронтенд-клиент идентифицирован, clientId: ${ws.clientId}, активных фронтенд-клиентов: ${clients.size}`);
            const initialData = Array.from(helperData.entries()).map(([helperId, screenshots]) => ({
                helperId,
                hasAnswer: screenshots.every(s => s.answer && s.answer.trim() !== '')
            }));
            ws.send(JSON.stringify({ type: 'initial_data', data: initialData, clientId: ws.clientId }));
        } else if (data.type === 'admin_connect' && data.role === 'admin') {
            ws.adminId = `admin-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            admins.set(ws.adminId, ws);
            console.log(`Сервер: Админ подключился, adminId: ${ws.adminId}, активных админов: ${admins.size}`);
            // Send all screenshots to the admin
            const allScreenshots = Array.from(helperData.entries()).flatMap(([helperId, screenshots]) =>
                screenshots.map(screenshot => ({
                    helperId,
                    questionId: screenshot.questionId,
                    imageUrl: screenshot.imageUrl,
                    clientId: screenshot.clientId,
                    answer: screenshot.answer
                }))
            );
            ws.send(JSON.stringify({
                type: 'all_screenshots',
                screenshots: allScreenshots,
                adminId: ws.adminId
            }));
            console.log(`Сервер: Отправлены все скриншоты админу ${ws.adminId}`);
        } else if (data.type === 'request_initial_data') {
            const initialData = Array.from(helperData.entries()).map(([helperId, screenshots]) => ({
                helperId,
                hasAnswer: screenshots.every(s => s.answer && s.answer.trim() !== '')
            }));
            ws.send(JSON.stringify({ type: 'initial_data', data: initialData, clientId: data.clientId || 'anonymous' }));
        } else if (data.type === 'helper_connect' && data.role === 'helper') {
            ws.helperId = data.helperId;
            helpers.set(data.helperId, ws);
            if (!helperData.has(data.helperId)) {
                helperData.set(data.helperId, []);
            }
            console.log(`Сервер: Подключился помощник с ID: ${data.helperId}, активных помощников: ${helpers.size}`);
        } else if (data.type === 'screenshot') {
            const uniqueTimeLabel = `save-screenshot-${data.helperId}-${Date.now()}`;
            console.time(uniqueTimeLabel);
            const timestamp = Date.now();
            const filename = `${data.helperId}-${timestamp}-0.png`;
            const screenshotPath = path.join(screenshotDir, filename);
            const buffer = Buffer.from(data.dataUrl.split(',')[1], 'base64');
            sharp(buffer)
                .resize({ width: 1280 })
                .png({ quality: 80 })
                .toFile(screenshotPath)
                .then(() => {
                    console.log(`Сервер: Скриншот сохранен: ${screenshotPath}`);
                    const imageUrl = `/screenshots/${filename}`;
                    const questionId = `${data.helperId}-${timestamp}-0`;
                    if (!helperData.has(data.helperId)) {
                        helperData.set(data.helperId, []);
                    }
                    helperData.get(data.helperId).push({ questionId, imageUrl, clientId: data.clientId || null, answer: '' });
                    // Notify frontends (except the sender) and admins
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            if (client.clientId && client.clientId !== data.clientId) {
                                client.send(JSON.stringify({
                                    type: 'screenshot_info',
                                    questionId,
                                    imageUrl,
                                    helperId: data.helperId,
                                    clientId: client.clientId
                                }));
                                console.log(`Сервер: Сообщение о скриншоте отправлено фронтенду ${client.clientId}`);
                            } else if (client.adminId) {
                                client.send(JSON.stringify({
                                    type: 'new_screenshot',
                                    questionId,
                                    imageUrl,
                                    helperId: data.helperId,
                                    clientId: data.clientId,
                                    adminId: client.adminId
                                }));
                                console.log(`Сервер: Сообщение о скриншоте отправлено админу ${client.adminId}`);
                            }
                        }
                    });
                    console.timeEnd(uniqueTimeLabel);
                })
                .catch(err => {
                    console.error('Сервер: Ошибка сохранения скриншота:', err);
                    console.timeEnd(uniqueTimeLabel);
                });
        } else if (data.type === 'submit_answer') {
            const { questionId, answer, clientId, adminId } = data;
            for (const [helperId, screenshots] of helperData.entries()) {
                const screenshot = screenshots.find(s => s.questionId === questionId);
                if (screenshot) {
                    screenshot.answer = answer;
                    const targetClientId = screenshot.clientId; // Client who sent the screenshot
                    const hasAnswer = screenshots.every(s => s.answer && s.answer.trim() !== '');
                    // Send answer to the specific client and helper
                    const targetClient = clients.get(targetClientId);
                    if (targetClient && targetClient.readyState === WebSocket.OPEN) {
                        targetClient.send(JSON.stringify({
                            type: 'answer',
                            questionId,
                            answer,
                            clientId: targetClientId
                        }));
                        console.log(`Сервер: Ответ отправлен клиенту ${targetClientId} для questionId: ${questionId}`);
                    }
                    const helperClient = helpers.get(helperId);
                    if (helperClient && helperClient.readyState === WebSocket.OPEN) {
                        helperClient.send(JSON.stringify({
                            type: 'answer',
                            questionId,
                            answer,
                            clientId: targetClientId
                        }));
                        console.log(`Сервер: Ответ отправлен помощнику ${helperId} для questionId: ${questionId}`);
                    }
                    // Notify all frontends and admins about the updated helper status
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN && client.clientId) {
                            client.send(JSON.stringify({
                                type: 'update_helper_card',
                                helperId,
                                hasAnswer,
                                clientId: client.clientId
                            }));
                        }
                        if (client.readyState === WebSocket.OPEN && client.adminId) {
                            client.send(JSON.stringify({
                                type: 'update_screenshot',
                                questionId,
                                answer,
                                helperId,
                                clientId: targetClientId,
                                adminId: client.adminId
                            }));
                        }
                    });
                    break;
                }
            }
        } else if (data.type === 'delete_screenshot') {
            const { questionId, clientId } = data;
            for (const [helperId, screenshots] of helperData.entries()) {
                const screenshotIndex = screenshots.findIndex(s => s.questionId === questionId);
                if (screenshotIndex !== -1) {
                    const screenshot = screenshots[screenshotIndex];
                    screenshots.splice(screenshotIndex, 1);
                    fs.unlink(path.join(screenshotDir, path.basename(screenshot.questionId)), (err) => {
                        if (err) console.error(`Сервер: Ошибка удаления файла ${screenshot.questionId}:`, err);
                        else console.log(`Сервер: Файл удален: ${screenshot.questionId}`);
                    });
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            if (client.clientId === clientId) {
                                client.send(JSON.stringify({
                                    type: 'screenshot_deleted_specific',
                                    questionId,
                                    clientId
                                }));
                            }
                            if (client.adminId) {
                                client.send(JSON.stringify({
                                    type: 'screenshot_deleted',
                                    questionId,
                                    helperId,
                                    adminId: client.adminId
                                }));
                            }
                        }
                    });
                    if (screenshots.length === 0) {
                        helperData.delete(helperId);
                        wss.clients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN && client.clientId) {
                                client.send(JSON.stringify({
                                    type: 'helper_deleted',
                                    helperId,
                                    clientId: client.clientId
                                }));
                            }
                            if (client.readyState === WebSocket.OPEN && client.adminId) {
                                client.send(JSON.stringify({
                                    type: 'helper_deleted',
                                    helperId,
                                    adminId: client.adminId
                                }));
                            }
                        });
                    }
                    break;
                }
            }
        } else if (data.type === 'request_helper_screenshots') {
            const helperInfo = helperData.get(data.helperId);
            if (helperInfo) {
                const frontendClient = clients.get(data.clientId) || ws;
                if (frontendClient && frontendClient.readyState === WebSocket.OPEN) {
                    frontendClient.send(JSON.stringify({
                        type: 'screenshots_by_helperId',
                        helperId: data.helperId,
                        screenshots: helperInfo,
                        clientId: data.clientId || 'anonymous'
                    }));
                }
            }
        } else if (data.type === 'request_all_screenshots' && data.role === 'admin') {
            const allScreenshots = Array.from(helperData.entries()).flatMap(([helperId, screenshots]) =>
                screenshots.map(screenshot => ({
                    helperId,
                    questionId: screenshot.questionId,
                    imageUrl: screenshot.imageUrl,
                    clientId: screenshot.clientId,
                    answer: screenshot.answer
                }))
            );
            ws.send(JSON.stringify({
                type: 'all_screenshots',
                screenshots: allScreenshots,
                adminId: ws.adminId
            }));
            console.log(`Сервер: Отправлены все скриншоты админу ${ws.adminId}`);
        }
    });

    ws.on('close', () => {
        console.log('Сервер: Клиент отключился');
        if (ws.clientId) {
            const clientId = ws.clientId;
            clients.delete(clientId);
            console.log(`Сервер: Фронтенд-клиент удален, clientId: ${clientId}, активных фронтенд-клиентов: ${clients.size}`);
            for (const [helperId, screenshots] of helperData.entries()) {
                const initialLength = screenshots.length;
                const helperClient = helpers.get(helperId);
                let hasClientScreenshots = false;
                screenshots.forEach((screenshot, index) => {
                    if (screenshot.clientId === clientId) {
                        const filePath = path.join(screenshotDir, path.basename(screenshot.questionId) + '.png');
                        if (fs.existsSync(filePath)) {
                            fs.unlink(filePath, (err) => {
                                if (err) console.error(`Сервер: Ошибка удаления файла ${filePath}:`, err);
                                else console.log(`Сервер: Файл удален при отключении: ${filePath}`);
                            });
                        } else {
                            console.warn(`Сервер: Файл не найден для удаления: ${filePath}`);
                        }
                        screenshots.splice(index, 1);
                        index--;
                    } else {
                        hasClientScreenshots = true;
                    }
                });
                if (!hasClientScreenshots && helperClient) {
                    helpers.delete(helperId);
                    console.log(`Сервер: Помощник с ID: ${helperId} удалён, так как нет активных скриншотов`);
                }
                if (screenshots.length === 0) {
                    helperData.delete(helperId);
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            if (client.clientId) {
                                client.send(JSON.stringify({
                                    type: 'helper_deleted',
                                    helperId,
                                    clientId: client.clientId
                                }));
                            }
                            if (client.adminId) {
                                client.send(JSON.stringify({
                                    type: 'helper_deleted',
                                    helperId,
                                    adminId: client.adminId
                                }));
                            }
                        }
                    });
                } else if (initialLength !== screenshots.length) {
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN && client.clientId) {
                            client.send(JSON.stringify({
                                type: 'update_helper_card',
                                helperId,
                                hasAnswer: screenshots.every(s => s.answer && s.answer.trim() !== ''),
                                clientId: client.clientId
                            }));
                        }
                    });
                }
            }
        }
        if (ws.helperId) {
            const helperId = ws.helperId;
            helpers.delete(helperId);
            console.log(`Сервер: Помощник с ID: ${helperId} отключился`);
            if (!Array.from(helpers.keys()).includes(helperId)) {
                if (helperData.has(helperId)) {
                    const screenshots = helperData.get(helperId);
                    screenshots.forEach(screenshot => {
                        const filePath = path.join(screenshotDir, path.basename(screenshot.questionId) + '.png');
                        if (fs.existsSync(filePath)) {
                            fs.unlink(filePath, (err) => {
                                if (err) console.error(`Сервер: Ошибка удаления файла ${filePath}:`, err);
                                else console.log(`Сервер: Файл удален при отключении помощника: ${filePath}`);
                            });
                        }
                    });
                    helperData.delete(helperId);
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            if (client.clientId) {
                                client.send(JSON.stringify({
                                    type: 'helper_deleted',
                                    helperId,
                                    clientId: client.clientId
                                }));
                            }
                            if (client.adminId) {
                                client.send(JSON.stringify({
                                    type: 'helper_deleted',
                                    helperId,
                                    adminId: client.adminId
                                }));
                            }
                        }
                    });
                }
            }
        }
        if (ws.adminId) {
            admins.delete(ws.adminId);
            console.log(`Сервер: Админ с ID: ${ws.adminId} отключился, активных админов: ${admins.size}`);
        }
    });
});

setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
        console.log('Сервер: Отправлен ping клиенту');
    });
}, 30000);

app.get('/status', (req, res) => {
    res.json({
        timestamp: new Date().toISOString(),
        status: 'active',
        helpersCount: helperData.size,
        frontendsCount: clients.size,
        adminsCount: admins.size,
        screenshotsCount: Array.from(helperData.values()).reduce((sum, v) => sum + v.length, 0),
        memoryUsage: process.memoryUsage()
    });
});

app.get('/list-screenshots', (req, res) => {
    fs.readdir(screenshotDir, (err, files) => {
        if (err) return res.status(500).send('Ошибка чтения папки');
        res.json(files);
    });
});

