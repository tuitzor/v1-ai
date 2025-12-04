const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Раздаем статические файлы из папки 'public'
app.use(express.static('public'));

// Хранилище данных
const admins = new Map();
const helpers = new Map();
const tests = new Map();
const helperTests = new Map();
const testAnswers = new Map();

function generateTestId() {
    return `test_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

const server = app.listen(port, () => {
    console.log(`✅ Сервер запущен на порту: ${port}`);
    console.log(`🌐 WebSocket доступен на ws://localhost:${port}`);
    console.log(`📁 Статические файлы: http://localhost:${port}/admin.html`);
});

const wss = new WebSocket.Server({ server });

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
            console.error('❌ Ошибка обработки:', error.message);
        }
    });
    
    ws.on('close', () => handleDisconnect(ws));
});

// Функции обработчики (оставьте те же что были ранее)
function handleHelperConnect(ws, data) {
    ws.helperId = data.helperId;
    ws.room = data.room || 'default';
    helpers.set(data.helperId, ws);
    
    console.log(`📝 Помощник: ${data.helperId}, комната: ${ws.room}`);
    
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
    
    const existingTestId = helperTests.get(ws.helperId);
    if (existingTestId) {
        tests.set(existingTestId, { ...tests.get(existingTestId), ...testData });
        console.log(`📝 Тест обновлен: ${ws.helperId}`);
    } else {
        tests.set(newTestId, testData);
        helperTests.set(ws.helperId, newTestId);
        testAnswers.set(newTestId, new Map());
        console.log(`📚 Новый тест: ${ws.helperId}, вопросов: ${testData.questions.length}`);
    }
    
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

// Очистка старых тестов
setInterval(() => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    
    for (const [testId, test] of tests.entries()) {
        if (now - test.timestamp > day) {
            tests.delete(testId);
            testAnswers.delete(testId);
            
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

// Keep-alive
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    });
}, 30000);

// API эндпоинты
app.get('/status', (req, res) => {
    res.json({
        status: 'active',
        helpers: helpers.size,
        admins: admins.size,
        tests: tests.size,
        timestamp: new Date().toISOString()
    });
});

// Основной маршрут
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Test System Server</title>
            <style>
                body { font-family: Arial; padding: 40px; text-align: center; }
                .card { background: #f5f5f5; padding: 30px; border-radius: 10px; margin: 20px auto; max-width: 600px; }
                .btn { display: inline-block; padding: 10px 20px; background: #4CAF50; color: white; text-decoration: none; border-radius: 5px; margin: 10px; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>🚀 Тестовая система</h1>
                <p>WebSocket сервер для синхронизации тестов</p>
                
                <div style="margin: 20px 0;">
                    <a href="/admin.html" class="btn">📊 Админ панель</a>
                    <a href="/status" class="btn">📈 Статус</a>
                </div>
                
                <div style="text-align: left; margin-top: 20px; background: white; padding: 15px; border-radius: 5px;">
                    <h3>Информация:</h3>
                    <p><strong>WebSocket:</strong> ws://localhost:${port}</p>
                    <p><strong>Пользователи:</strong> ${helpers.size}</p>
                    <p><strong>Админы:</strong> ${admins.size}</p>
                    <p><strong>Активных тестов:</strong> ${tests.size}</p>
                </div>
            </div>
        </body>
        </html>
    `);
});

console.log('✅ Сервер запущен!');
