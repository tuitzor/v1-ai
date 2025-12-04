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
                    const testId = helperTests.get(data.helperId);
                    if (testId) {
                        const answers = testAnswers.get(testId);
                        if (answers) {
                            ws.send(JSON.stringify({
                                type: 'test_answers',
                                testId: testId,
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
                    
                    const testId = `test_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
                    const testData = {
                        helperId: ws.helperId,
                        url: data.url || 'unknown',
                        questions: data.questions,
                        timestamp: Date.now()
                    };
                    
                    tests.set(testId, testData);
                    helperTests.set(ws.helperId, testId);
                    testAnswers.set(testId, new Map());
                    
                    console.log(`📚 Тест получен от ${ws.helperId}: ${testData.questions.length} вопросов`);
                    
                    // Отправляем тест всем админам
                    admins.forEach(adminWs => {
                        if (adminWs.readyState === WebSocket.OPEN) {
                            adminWs.send(JSON.stringify({
                                type: 'new_test',
                                testId,
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

console.log('✅ Фоновая система тестов запущена!');
