const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const server = app.listen(port, () => {
    console.log(`✅ Сервер запущен на порту: ${port}`);
    console.log(`🌐 WebSocket доступен на ws://localhost:${port}`);
});

const wss = new WebSocket.Server({ server });

// Хранилище данных
const admins = new Map(); // adminId -> WebSocket
const helpers = new Map(); // helperId -> WebSocket
const tests = new Map(); // testId -> { questions, answers }
const helperTests = new Map(); // helperId -> testId
const testAnswers = new Map(); // testId -> Map(questionId -> { answer, adminId })

wss.on('connection', (ws) => {
    console.log('🔗 Новое соединение');
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.type) {
                case 'helper_connect':
                    // Помощник (пользователь на сайте с тестом)
                    ws.helperId = data.helperId;
                    helpers.set(data.helperId, ws);
                    console.log(`📝 Помощник подключен: ${data.helperId}`);
                    
                    // Отправляем существующие ответы если есть
                    const savedTestId = helperTests.get(data.helperId);
                    if (savedTestId) {
                        const answers = testAnswers.get(savedTestId);
                        if (answers) {
                            ws.send(JSON.stringify({
                                type: 'test_answers',
                                testId: savedTestId,
                                answers: Array.from(answers.entries())
                            }));
                        }
                    }
                    break;
                    
                case 'admin_connect':
                    // Админ (отвечает на вопросы)
                    ws.adminId = data.adminId;
                    admins.set(data.adminId, ws);
                    console.log(`👑 Админ подключен: ${data.adminId}`);
                    
                    // Отправляем все активные тесты админу
                    const allTests = Array.from(tests.entries()).map(([testId, test]) => ({
                        testId,
                        helperId: Array.from(helperTests.entries()).find(([hId, tId]) => tId === testId)?.[0],
                        questions: test.questions,
                        answers: testAnswers.get(testId) ? Array.from(testAnswers.get(testId).entries()) : []
                    }));
                    
                    ws.send(JSON.stringify({
                        type: 'all_tests',
                        tests: allTests
                    }));
                    break;
                    
                case 'send_test':
                    // Помощник отправил тест
                    if (!ws.helperId) break;
                    
                    const newTestId = `test_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
                    const testData = {
                        helperId: ws.helperId,
                        url: data.url || 'unknown',
                        questions: data.questions,
                        timestamp: Date.now()
                    };
                    
                    tests.set(newTestId, testData);
                    helperTests.set(ws.helperId, newTestId);
                    testAnswers.set(newTestId, new Map());
                    
                    console.log(`📚 Тест получен от ${ws.helperId}: ${testData.questions.length} вопросов`);
                    
                    // Отправляем тест всем админам
                    admins.forEach(adminWs => {
                        if (adminWs.readyState === WebSocket.OPEN) {
                            adminWs.send(JSON.stringify({
                                type: 'new_test',
                                testId: newTestId,
                                ...testData
                            }));
                        }
                    });
                    break;
                    
                case 'submit_answer':
                    // Админ отправил ответ
                    if (!ws.adminId) break;
                    
                    const { testId: answerTestId, questionId, answer } = data;
                    const answersMap = testAnswers.get(answerTestId);
                    
                    if (answersMap) {
                        answersMap.set(questionId, {
                            answer: answer,
                            adminId: ws.adminId,
                            timestamp: Date.now()
                        });
                        
                        console.log(`✅ Ответ на вопрос ${questionId} от админа ${ws.adminId}`);
                        
                        // Отправляем ответ помощнику
                        const test = tests.get(answerTestId);
                        if (test && test.helperId) {
                            const helperWs = helpers.get(test.helperId);
                            if (helperWs && helperWs.readyState === WebSocket.OPEN) {
                                helperWs.send(JSON.stringify({
                                    type: 'answer_update',
                                    questionId,
                                    answer,
                                    testId: answerTestId
                                }));
                            }
                        }
                        
                        // Обновляем всех админов
                        admins.forEach(adminWs => {
                            if (adminWs.readyState === WebSocket.OPEN && adminWs !== ws) {
                                adminWs.send(JSON.stringify({
                                    type: 'answer_update',
                                    testId: answerTestId,
                                    questionId,
                                    answer,
                                    adminId: ws.adminId
                                }));
                            }
                        });
                    }
                    break;
                    
                case 'request_answers':
                    // Помощник запрашивает ответы
                    if (!ws.helperId) break;
                    
                    const helperTestId = helperTests.get(ws.helperId);
                    if (helperTestId) {
                        const answers = testAnswers.get(helperTestId);
                        if (answers) {
                            ws.send(JSON.stringify({
                                type: 'test_answers',
                                testId: helperTestId,
                                answers: Array.from(answers.entries())
                            }));
                        }
                    }
                    break;
                    
                case 'request_all_tests':
                    // Админ запрашивает все тесты
                    if (!ws.adminId) break;
                    
                    const allTestsForAdmin = Array.from(tests.entries()).map(([testId, test]) => ({
                        testId,
                        helperId: Array.from(helperTests.entries()).find(([hId, tId]) => tId === testId)?.[0],
                        questions: test.questions,
                        answers: testAnswers.get(testId) ? Array.from(testAnswers.get(testId).entries()) : []
                    }));
                    
                    ws.send(JSON.stringify({
                        type: 'all_tests',
                        tests: allTestsForAdmin
                    }));
                    break;
            }
        } catch (error) {
            console.error('❌ Ошибка обработки сообщения:', error.message);
        }
    });
    
    ws.on('close', () => {
        if (ws.helperId) {
            helpers.delete(ws.helperId);
            console.log(`📝 Помощник отключен: ${ws.helperId}`);
        }
        if (ws.adminId) {
            admins.delete(ws.adminId);
            console.log(`👑 Админ отключен: ${ws.adminId}`);
        }
    });
});

// Очистка старых тестов (старше 24 часов)
setInterval(() => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    
    for (const [testId, test] of tests.entries()) {
        if (now - test.timestamp > day) {
            tests.delete(testId);
            testAnswers.delete(testId);
            
            // Удаляем из helperTests
            for (const [helperId, tId] of helperTests.entries()) {
                if (tId === testId) {
                    helperTests.delete(helperId);
                    break;
                }
            }
            
            console.log(`🗑️ Удален старый тест: ${testId}`);
        }
    }
}, 3600000); // Каждый час

app.get('/status', (req, res) => {
    res.json({
        status: 'active',
        helpers: helpers.size,
        admins: admins.size,
        tests: tests.size,
        timestamp: new Date().toISOString()
    });
});

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Сервер тестов</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 20px; }
                .status { background: #f0f0f0; padding: 20px; border-radius: 10px; margin: 10px 0; }
                .connected { color: green; }
                .disconnected { color: red; }
            </style>
        </head>
        <body>
            <h1>Сервер системы тестов</h1>
            <div class="status">
                <h2>Статус: <span class="connected">✅ Активен</span></h2>
                <p>WebSocket: ws://localhost:${port}</p>
                <p>Админ панель: <a href="/admin">/admin</a></p>
            </div>
        </body>
        </html>
    `);
});

app.get('/admin', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

console.log('✅ Фоновая система тестов запущена!');
console.log(`🌐 Админ панель доступна по адресу: http://localhost:${port}/admin`);
