const express = require('express');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const cheerio = require('cheerio');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 10000;
const secretKey = 'your-secret-key';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(port, () => {
    console.log(`✅ Сервер запущен на порту: ${port}`);
    console.log(`🌐 WebSocket доступен на ws://localhost:${port}`);
    console.log(`🚪 Доступны комнаты: 1, 2, 3...`);
});

const wss = new WebSocket.Server({ server });

// Структуры данных для комнатной системы
const rooms = new Map();        // roomId -> Room object
const users = new Map();        // userId -> User object
const userConnections = new Map(); // userId -> WebSocket

class Room {
    constructor(roomId) {
        this.id = roomId;
        this.users = new Set(); // userIds
        this.testData = null;   // текущий тест в комнате
        this.answers = new Map(); // questionId -> { userId, answer, timestamp, userName }
        this.chat = [];         // история сообщений
        this.createdAt = Date.now();
        this.lastActivity = Date.now();
        this.testLoadedBy = null; // кто загрузил тест
        this.testLoadedAt = null;
    }
    
    addUser(userId) {
        this.users.add(userId);
        this.lastActivity = Date.now();
    }
    
    removeUser(userId) {
        this.users.delete(userId);
        this.lastActivity = Date.now();
    }
    
    hasUser(userId) {
        return this.users.has(userId);
    }
    
    getUserCount() {
        return this.users.size;
    }
    
    updateTest(testData, loadedByUserId) {
        this.testData = testData;
        this.testLoadedBy = loadedByUserId;
        this.testLoadedAt = Date.now();
        this.answers.clear(); // очищаем старые ответы при новом тесте
        this.lastActivity = Date.now();
    }
    
    submitAnswer(questionId, answer, userId, userName) {
        this.answers.set(questionId, {
            userId,
            userName,
            answer,
            timestamp: Date.now()
        });
        this.lastActivity = Date.now();
    }
    
    getAnswer(questionId) {
        return this.answers.get(questionId);
    }
    
    getAllAnswers() {
        return Array.from(this.answers.entries()).map(([questionId, data]) => ({
            questionId,
            ...data
        }));
    }
    
    addChatMessage(userId, userName, message) {
        this.chat.push({
            userId,
            userName,
            message,
            timestamp: Date.now()
        });
        // Держим только последние 100 сообщений
        if (this.chat.length > 100) {
            this.chat = this.chat.slice(-100);
        }
        this.lastActivity = Date.now();
    }
    
    getChatHistory(count = 50) {
        return this.chat.slice(-count);
    }
    
    getRoomInfo() {
        return {
            id: this.id,
            userCount: this.getUserCount(),
            hasTest: !!this.testData,
            testLoadedBy: this.testLoadedBy,
            testLoadedAt: this.testLoadedAt,
            answerCount: this.answers.size,
            createdAt: this.createdAt,
            lastActivity: this.lastActivity
        };
    }
}

class User {
    constructor(userId, userName, ws, roomId = null) {
        this.id = userId;
        this.name = userName;
        this.ws = ws;
        this.roomId = roomId;
        this.joinedAt = Date.now();
        this.lastActive = Date.now();
    }
    
    setRoom(roomId) {
        this.roomId = roomId;
        this.lastActive = Date.now();
    }
    
    leaveRoom() {
        this.roomId = null;
        this.lastActive = Date.now();
    }
    
    updateActivity() {
        this.lastActive = Date.now();
    }
}

// API для авторизации (оставляем для совместимости)
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

// API для парсинга теста
app.post('/api/parse-test', async (req, res) => {
    try {
        const { url, html } = req.body;
        
        let testData;
        if (html) {
            testData = parseTestFromHTML(html, url || 'current-page');
        } else if (url) {
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                timeout: 10000
            });
            testData = parseTestFromHTML(response.data, url);
        } else {
            return res.status(400).json({ error: 'Нужен URL или HTML контент' });
        }
        
        res.json({ success: true, testData });
    } catch (error) {
        console.error('❌ Ошибка парсинга теста:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Функция парсинга теста из HTML
function parseTestFromHTML(html, baseUrl) {
    const $ = cheerio.load(html);
    const testData = {
        url: baseUrl,
        title: $('title').text() || 'Тест',
        pageTitle: $('h1').text() || 'Тестовая страница',
        questions: [],
        parsedAt: new Date().toISOString()
    };
    
    // Парсим вопросы (адаптируйте селекторы под ваш сайт)
    $('.table-test, .test-item, .question').each((index, element) => {
        const question = {
            id: $(element).attr('id') || `q${index + 1}`,
            number: index + 1,
            text: '',
            html: '',
            imageUrl: '',
            options: [],
            type: 'single' // или multiple
        };
        
        // Текст вопроса
        question.text = $(element).find('.test-question').text().trim();
        question.html = $(element).find('.test-question').html() || '';
        
        // Изображение вопроса
        const img = $(element).find('.test-question img');
        if (img.length) {
            const src = img.attr('src');
            question.imageUrl = src.startsWith('http') ? src : new URL(src, baseUrl).href;
        }
        
        // Варианты ответов
        $(element).find('.answers-test li, .option').each((optIndex, optEl) => {
            const option = {
                id: $(optEl).find('input').attr('id') || `q${index + 1}_opt${optIndex + 1}`,
                letter: String.fromCharCode(97 + optIndex), // a, b, c, d
                text: $(optEl).find('p').text().trim(),
                html: $(optEl).find('p').html() || '',
                imageUrl: '',
                value: $(optEl).find('input').attr('value') || (optIndex + 1)
            };
            
            // Изображение варианта
            const optImg = $(optEl).find('img');
            if (optImg.length) {
                const optSrc = optImg.attr('src');
                option.imageUrl = optSrc.startsWith('http') ? optSrc : new URL(optSrc, baseUrl).href;
            }
            
            question.options.push(option);
        });
        
        testData.questions.push(question);
    });
    
    // Если не нашли по стандартным селекторам, пытаемся найти любые вопросы
    if (testData.questions.length === 0) {
        $('form, .test, .quiz').each((index, element) => {
            const inputs = $(element).find('input[type="radio"], input[type="checkbox"]');
            if (inputs.length > 0) {
                // Собираем вопросы по группам
                const questionGroups = {};
                
                inputs.each((i, input) => {
                    const name = $(input).attr('name');
                    if (!questionGroups[name]) {
                        questionGroups[name] = {
                            id: name || `q${index}`,
                            number: Object.keys(questionGroups).length + 1,
                            text: $(input).closest('label').text().trim() || `Вопрос ${Object.keys(questionGroups).length + 1}`,
                            options: []
                        };
                    }
                    
                    const label = $(input).next('label').text() || $(input).closest('label').text();
                    questionGroups[name].options.push({
                        id: $(input).attr('id'),
                        text: label.trim(),
                        value: $(input).attr('value')
                    });
                });
                
                Object.values(questionGroups).forEach(q => {
                    testData.questions.push(q);
                });
            }
        });
    }
    
    testData.totalQuestions = testData.questions.length;
    return testData;
}

// Обработка WebSocket соединений
wss.on('connection', (ws) => {
    console.log('🔗 Новое соединение');
    ws.isAlive = true;
    ws.userId = null;
    ws.roomId = null;
    
    ws.on('pong', () => {
        ws.isAlive = true;
    });
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('📨 Получено:', data.type);
            
            switch (data.type) {
                case 'join_room':
                    handleJoinRoom(ws, data);
                    break;
                    
                case 'leave_room':
                    handleLeaveRoom(ws);
                    break;
                    
                case 'parse_test':
                    await handleParseTest(ws, data);
                    break;
                    
                case 'submit_answer':
                    handleSubmitAnswer(ws, data);
                    break;
                    
                case 'request_answers':
                    handleRequestAnswers(ws, data);
                    break;
                    
                case 'chat_message':
                    handleChatMessage(ws, data);
                    break;
                    
                case 'set_user_name':
                    handleSetUserName(ws, data);
                    break;
                    
                case 'request_room_info':
                    handleRequestRoomInfo(ws, data);
                    break;
                    
                case 'request_chat_history':
                    handleRequestChatHistory(ws, data);
                    break;
            }
        } catch (error) {
            console.error('❌ Ошибка обработки сообщения:', error.message);
            sendError(ws, error.message);
        }
    });
    
    ws.on('close', () => {
        console.log('👋 Отключение');
        handleLeaveRoom(ws);
        if (ws.userId) {
            users.delete(ws.userId);
            userConnections.delete(ws.userId);
        }
    });
    
    ws.on('error', (error) => {
        console.error('🔥 Ошибка WebSocket:', error.message);
    });
    
    // Отправляем приветственное сообщение
    ws.send(JSON.stringify({
        type: 'welcome',
        message: 'Добро пожаловать в систему комнат для тестов. Введите номер комнаты (1, 2, 3...) для присоединения.'
    }));
});

// Обработчики сообщений
function handleJoinRoom(ws, data) {
    const { roomId, userName } = data;
    
    if (!roomId || roomId.trim() === '') {
        sendError(ws, 'Номер комнаты не может быть пустым');
        return;
    }
    
    // Генерируем ID пользователя, если нет
    if (!ws.userId) {
        ws.userId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    
    // Выходим из предыдущей комнаты, если есть
    if (ws.roomId) {
        handleLeaveRoom(ws);
    }
    
    // Создаем комнату, если не существует
    if (!rooms.has(roomId)) {
        rooms.set(roomId, new Room(roomId));
        console.log(`🚀 Создана комната ${roomId}`);
    }
    
    const room = rooms.get(roomId);
    const userId = ws.userId;
    const finalUserName = userName || `Участник_${userId.substr(0, 4)}`;
    
    // Создаем или обновляем пользователя
    let user = users.get(userId);
    if (!user) {
        user = new User(userId, finalUserName, ws, roomId);
        users.set(userId, user);
        userConnections.set(userId, ws);
    } else {
        user.setRoom(roomId);
        user.name = finalUserName;
    }
    
    // Добавляем пользователя в комнату
    room.addUser(userId);
    ws.roomId = roomId;
    
    // Отправляем подтверждение пользователю
    ws.send(JSON.stringify({
        type: 'room_joined',
        roomId,
        userId,
        userName: finalUserName,
        userCount: room.getUserCount(),
        roomInfo: room.getRoomInfo(),
        testData: room.testData
    }));
    
    // Уведомляем других участников комнаты
    broadcastToRoom(roomId, {
        type: 'user_joined',
        userId,
        userName: finalUserName,
        userCount: room.getUserCount()
    }, userId);
    
    console.log(`👥 ${finalUserName} присоединился к комнате ${roomId}`);
}

function handleLeaveRoom(ws) {
    if (!ws.userId || !ws.roomId) return;
    
    const userId = ws.userId;
    const roomId = ws.roomId;
    const room = rooms.get(roomId);
    
    if (!room) return;
    
    const user = users.get(userId);
    if (!user) return;
    
    room.removeUser(userId);
    user.leaveRoom();
    
    // Если комната пустая, удаляем через некоторое время
    if (room.getUserCount() === 0) {
        setTimeout(() => {
            if (rooms.has(roomId) && rooms.get(roomId).getUserCount() === 0) {
                rooms.delete(roomId);
                console.log(`🗑️ Удалена пустая комната ${roomId}`);
            }
        }, 300000); // 5 минут
    }
    
    // Уведомляем других участников
    broadcastToRoom(roomId, {
        type: 'user_left',
        userId,
        userName: user.name,
        userCount: room.getUserCount()
    }, userId);
    
    console.log(`👋 ${user.name} покинул комнату ${roomId}`);
    
    ws.roomId = null;
}

async function handleParseTest(ws, data) {
    const { roomId, url, htmlContent } = data;
    
    if (!ws.userId || !ws.roomId || ws.roomId !== roomId) {
        sendError(ws, 'Вы не состоите в этой комнате');
        return;
    }
    
    const room = rooms.get(roomId);
    if (!room) {
        sendError(ws, 'Комната не найдена');
        return;
    }
    
    const user = users.get(ws.userId);
    if (!user) {
        sendError(ws, 'Пользователь не найден');
        return;
    }
    
    try {
        let testData;
        
        if (htmlContent) {
            // Используем предоставленный HTML
            testData = parseTestFromHTML(htmlContent, url || 'current-page');
        } else if (url) {
            // Загружаем со страницы через API
            const response = await axios.post('http://localhost:' + port + '/api/parse-test', {
                url: url
            });
            
            if (response.data.success) {
                testData = response.data.testData;
            } else {
                throw new Error('Ошибка парсинга теста');
            }
        } else {
            // Пытаемся распарсить текущую страницу из DOM
            sendError(ws, 'Для загрузки теста нужен URL или HTML');
            return;
        }
        
        // Обновляем тест в комнате
        room.updateTest(testData, user.id);
        
        // Рассылаем обновленный тест всем в комнате
        broadcastToRoom(roomId, {
            type: 'test_loaded',
            testData: testData,
            loadedBy: user.name,
            loadedById: user.id,
            timestamp: Date.now()
        });
        
        console.log(`📚 Тест загружен в комнату ${roomId} пользователем ${user.name}`);
        
    } catch (error) {
        console.error('❌ Ошибка парсинга теста:', error.message);
        sendError(ws, `Ошибка загрузки теста: ${error.message}`);
    }
}

function handleSubmitAnswer(ws, data) {
    const { roomId, questionId, answer } = data;
    
    if (!ws.userId || !ws.roomId || ws.roomId !== roomId) {
        sendError(ws, 'Вы не состоите в этой комнате');
        return;
    }
    
    const room = rooms.get(roomId);
    if (!room) {
        sendError(ws, 'Комната не найдена');
        return;
    }
    
    const user = users.get(ws.userId);
    if (!user) {
        sendError(ws, 'Пользователь не найден');
        return;
    }
    
    // Сохраняем ответ в комнате
    room.submitAnswer(questionId, answer, user.id, user.name);
    
    // Рассылаем обновление всем в комнате
    broadcastToRoom(roomId, {
        type: 'answer_submitted',
        questionId,
        answer,
        userId: user.id,
        userName: user.name,
        timestamp: Date.now()
    }, user.id);
    
    console.log(`✅ Ответ на вопрос ${questionId} от ${user.name} в комнате ${roomId}`);
}

function handleRequestAnswers(ws, data) {
    const { roomId } = data;
    
    if (!ws.userId || !ws.roomId || ws.roomId !== roomId) {
        sendError(ws, 'Вы не состоите в этой комнате');
        return;
    }
    
    const room = rooms.get(roomId);
    if (!room) {
        sendError(ws, 'Комната не найдена');
        return;
    }
    
    // Отправляем все ответы из комнаты
    ws.send(JSON.stringify({
        type: 'room_answers',
        roomId,
        answers: room.getAllAnswers()
    }));
}

function handleChatMessage(ws, data) {
    const { roomId, message } = data;
    
    if (!ws.userId || !ws.roomId || ws.roomId !== roomId) {
        sendError(ws, 'Вы не состоите в этой комнате');
        return;
    }
    
    const room = rooms.get(roomId);
    if (!room) {
        sendError(ws, 'Комната не найдена');
        return;
    }
    
    const user = users.get(ws.userId);
    if (!user) {
        sendError(ws, 'Пользователь не найден');
        return;
    }
    
    if (!message || message.trim() === '') {
        sendError(ws, 'Сообщение не может быть пустым');
        return;
    }
    
    // Добавляем сообщение в историю чата
    room.addChatMessage(user.id, user.name, message.trim());
    
    // Рассылаем сообщение всем в комнате
    broadcastToRoom(roomId, {
        type: 'chat_message',
        userId: user.id,
        userName: user.name,
        message: message.trim(),
        timestamp: Date.now()
    }, user.id);
    
    console.log(`💬 Сообщение от ${user.name} в комнате ${roomId}: ${message}`);
}

function handleSetUserName(ws, data) {
    const { userName } = data;
    
    if (!ws.userId) {
        sendError(ws, 'Пользователь не идентифицирован');
        return;
    }
    
    if (!userName || userName.trim() === '') {
        sendError(ws, 'Имя не может быть пустым');
        return;
    }
    
    const user = users.get(ws.userId);
    if (!user) {
        sendError(ws, 'Пользователь не найден');
        return;
    }
    
    const oldName = user.name;
    user.name = userName.trim();
    
    // Если пользователь в комнате, уведомляем других
    if (user.roomId) {
        const room = rooms.get(user.roomId);
        if (room) {
            broadcastToRoom(user.roomId, {
                type: 'user_name_changed',
                userId: user.id,
                oldName,
                newName: user.name
            }, user.id);
        }
    }
    
    ws.send(JSON.stringify({
        type: 'user_name_updated',
        userName: user.name
    }));
    
    console.log(`📝 Пользователь ${user.id} сменил имя с "${oldName}" на "${user.name}"`);
}

function handleRequestRoomInfo(ws, data) {
    const { roomId } = data;
    
    if (!ws.userId || !ws.roomId || ws.roomId !== roomId) {
        sendError(ws, 'Вы не состоите в этой комнате');
        return;
    }
    
    const room = rooms.get(roomId);
    if (!room) {
        sendError(ws, 'Комната не найдена');
        return;
    }
    
    // Собираем информацию об участниках
    const participants = Array.from(room.users).map(userId => {
        const user = users.get(userId);
        return user ? {
            id: user.id,
            name: user.name,
            joinedAt: user.joinedAt
        } : null;
    }).filter(Boolean);
    
    ws.send(JSON.stringify({
        type: 'room_info',
        roomId,
        info: room.getRoomInfo(),
        participants,
        chatHistory: room.getChatHistory(20)
    }));
}

function handleRequestChatHistory(ws, data) {
    const { roomId, count = 50 } = data;
    
    if (!ws.userId || !ws.roomId || ws.roomId !== roomId) {
        sendError(ws, 'Вы не состоите в этой комнате');
        return;
    }
    
    const room = rooms.get(roomId);
    if (!room) {
        sendError(ws, 'Комната не найдена');
        return;
    }
    
    ws.send(JSON.stringify({
        type: 'chat_history',
        roomId,
        messages: room.getChatHistory(count)
    }));
}

// Вспомогательные функции
function broadcastToRoom(roomId, message, excludeUserId = null) {
    const room = rooms.get(roomId);
    if (!room) return;
    
    room.users.forEach(userId => {
        if (excludeUserId && userId === excludeUserId) return;
        
        const user = users.get(userId);
        if (user && user.ws && user.ws.readyState === WebSocket.OPEN) {
            user.ws.send(JSON.stringify(message));
        }
    });
}

function sendError(ws, message) {
    ws.send(JSON.stringify({
        type: 'error',
        message: message
    }));
}

// Очистка неактивных соединений
setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
    
    // Очистка неактивных комнат
    const now = Date.now();
    for (const [roomId, room] of rooms.entries()) {
        if (room.getUserCount() === 0 && now - room.lastActivity > 3600000) { // 1 час
            rooms.delete(roomId);
            console.log(`🗑️ Удалена неактивная комната ${roomId}`);
        }
    }
}, 30000);

// API статуса
app.get('/status', (req, res) => {
    res.json({
        timestamp: new Date().toISOString(),
        status: 'active',
        rooms: Array.from(rooms.keys()),
        roomsCount: rooms.size,
        usersCount: users.size,
        activeConnections: wss.clients.size
    });
});

app.get('/rooms/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    const room = rooms.get(roomId);
    
    if (!room) {
        return res.status(404).json({ error: 'Комната не найдена' });
    }
    
    res.json(room.getRoomInfo());
});

console.log('✅ Система комнат для тестов запущена!');
console.log('📱 Подключитесь через WebSocket к ws://localhost:' + port);
console.log('🚪 Для работы используйте комнаты: 1, 2, 3...');
