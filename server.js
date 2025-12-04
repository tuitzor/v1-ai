const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Хранилище данных
const admins = new Map(); // adminId -> WebSocket
const helpers = new Map(); // helperId -> WebSocket
const tests = new Map(); // testId -> { questions, answers, helperId, timestamp }
const helperTests = new Map(); // helperId -> testId
const testAnswers = new Map(); // testId -> Map(questionId -> { answer, adminId, timestamp })

// Функция генерации ID теста
function generateTestId() {
    return `test_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

const server = app.listen(port, () => {
    console.log(`✅ Сервер запущен на порту: ${port}`);
    console.log(`🌐 WebSocket доступен на порту: ${port}`);
    console.log(`🚪 Система комнат: 1, 2, 3...`);
});

const wss = new WebSocket.Server({ server });

// Обработка WebSocket соединений
wss.on('connection', (ws) => {
    console.log('🔗 Новое соединение');
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.type) {
                case 'helper_connect':
                    handleHelperConnect(ws, data);
                    break;
                    
                case 'admin_connect':
                    handleAdminConnect(ws, data);
                    break;
                    
                case 'send_test':
                    handleSendTest(ws, data);
                    break;
                    
                case 'submit_answer':
                    handleSubmitAnswer(ws, data);
                    break;
                    
                case 'request_answers':
                    handleRequestAnswers(ws, data);
                    break;
                    
                case 'request_all_tests':
                    handleRequestAllTests(ws, data);
                    break;
                    
                case 'ping':
                    ws.send(JSON.stringify({ type: 'pong' }));
                    break;
            }
        } catch (error) {
            console.error('❌ Ошибка обработки сообщения:', error.message);
        }
    });
    
    ws.on('close', () => {
        handleDisconnect(ws);
    });
    
    ws.on('error', (error) => {
        console.error('🔥 WebSocket error:', error.message);
    });
});

// Обработчики сообщений
function handleHelperConnect(ws, data) {
    ws.helperId = data.helperId;
    ws.room = data.room || 'default';
    helpers.set(data.helperId, ws);
    
    console.log(`📝 Помощник подключен: ${data.helperId}, комната: ${ws.room}`);
    
    // Отправляем существующие ответы
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
}

function handleAdminConnect(ws, data) {
    ws.adminId = data.adminId;
    admins.set(data.adminId, ws);
    
    console.log(`👑 Админ подключен: ${data.adminId}`);
    
    // Отправляем все активные тесты
    sendAllTestsToAdmin(ws);
}

function handleSendTest(ws, data) {
    if (!ws.helperId) return;
    
    const newTestId = generateTestId();
    const testData = {
        helperId: ws.helperId,
        room: data.room || ws.room || 'default',
        url: data.url || 'unknown',
        questions: data.questions || [],
        title: data.title || 'Тест',
        timestamp: Date.now()
    };
    
    // Проверяем, есть ли уже тест у этого помощника
    const existingTestId = helperTests.get(ws.helperId);
    if (existingTestId) {
        // Обновляем существующий тест
        tests.set(existingTestId, { ...tests.get(existingTestId), ...testData });
        console.log(`📝 Тест обновлен: ${ws.helperId}`);
    } else {
        // Создаем новый тест
        tests.set(newTestId, testData);
        helperTests.set(ws.helperId, newTestId);
        testAnswers.set(newTestId, new Map());
        console.log(`📚 Новый тест: ${ws.helperId}, вопросов: ${testData.questions.length}`);
    }
    
    // Отправляем всем админам
    broadcastToAdmins({
        type: 'new_test',
        testId: existingTestId || newTestId,
        ...testData
    });
}

function handleSubmitAnswer(ws, data) {
    if (!ws.adminId) return;
    
    const { testId, questionId, answer } = data;
    const answersMap = testAnswers.get(testId);
    
    if (answersMap) {
        answersMap.set(questionId, {
            answer: answer,
            adminId: ws.adminId,
            timestamp: Date.now()
        });
        
        console.log(`✅ Ответ на вопрос ${questionId} от админа ${ws.adminId}`);
        
        // Отправляем ответ пользователю
        const test = tests.get(testId);
        if (test && test.helperId) {
            const helperWs = helpers.get(test.helperId);
            if (helperWs && helperWs.readyState === WebSocket.OPEN) {
                helperWs.send(JSON.stringify({
                    type: 'answer_update',
                    questionId,
                    answer,
                    testId
                }));
            }
        }
        
        // Обновляем всех админов
        broadcastToAdmins({
            type: 'answer_update',
            testId,
            questionId,
            answer,
            adminId: ws.adminId
        }, ws.adminId);
    }
}

function handleRequestAnswers(ws, data) {
    if (!ws.helperId) return;
    
    const testId = helperTests.get(ws.helperId);
    if (testId) {
        const answers = testAnswers.get(testId);
        if (answers) {
            ws.send(JSON.stringify({
                type: 'test_answers',
                testId,
                answers: Array.from(answers.entries())
            }));
        }
    }
}

function handleRequestAllTests(ws, data) {
    if (!ws.adminId) return;
    sendAllTestsToAdmin(ws);
}

function handleDisconnect(ws) {
    if (ws.helperId) {
        helpers.delete(ws.helperId);
        console.log(`📝 Помощник отключен: ${ws.helperId}`);
    }
    if (ws.adminId) {
        admins.delete(ws.adminId);
        console.log(`👑 Админ отключен: ${ws.adminId}`);
    }
}

// Вспомогательные функции
function sendAllTestsToAdmin(adminWs) {
    const allTests = Array.from(tests.entries()).map(([testId, test]) => ({
        testId,
        helperId: test.helperId,
        room: test.room,
        url: test.url,
        title: test.title,
        questions: test.questions,
        answers: testAnswers.get(testId) ? Array.from(testAnswers.get(testId).entries()) : [],
        timestamp: test.timestamp
    }));
    
    adminWs.send(JSON.stringify({
        type: 'all_tests',
        tests: allTests
    }));
}

function broadcastToAdmins(message, excludeAdminId = null) {
    admins.forEach((adminWs, adminId) => {
        if (adminWs.readyState === WebSocket.OPEN && adminId !== excludeAdminId) {
            adminWs.send(JSON.stringify(message));
        }
    });
}

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
}, 3600000);

// Keep-alive для соединений
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    });
}, 30000);

// Простой статус эндпоинт
app.get('/status', (req, res) => {
    res.json({
        status: 'active',
        helpers: helpers.size,
        admins: admins.size,
        tests: tests.size,
        timestamp: new Date().toISOString()
    });
});

// Корневой эндпоинт для проверки
app.get('/', (req, res) => {
    res.json({
        message: 'Test System Server',
        endpoints: {
            status: '/status',
            websocket: `ws://localhost:${port}`
        }
    });
});

console.log('✅ WebSocket сервер запущен!');
