(async () => {
    'use strict';
    
    const production = location.protocol === 'https:' ? 'wss://v1-ai.onrender.com' : 'ws://localhost:10000';
    let socket = null;
    let isConnected = false;
    
    // Определяем номер комнаты из URL или генерируем случайный
    const getRoomNumber = () => {
        // Можно использовать hash или параметр в URL
        const hash = window.location.hash.substring(1);
        if (hash && /^\d+$/.test(hash)) {
            return parseInt(hash);
        }
        
        // Или из localStorage
        const savedRoom = localStorage.getItem('test_room');
        if (savedRoom && /^\d+$/.test(savedRoom)) {
            return parseInt(savedRoom);
        }
        
        // Случайная комната 1-3
        return Math.floor(Math.random() * 3) + 1;
    };
    
    const roomNumber = getRoomNumber();
    const helperId = `helper-room${roomNumber}-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    
    console.log(`[H] Комната ${roomNumber}, ID: ${helperId}`);
    
    const answers = new Map();
    
    // Стили для невидимой подсветки
    const style = document.createElement('style');
    style.textContent = `
        .auto-answer-highlight {
            position: relative !important;
        }
        .auto-answer-highlight::after {
            content: '' !important;
            position: absolute !important;
            top: 0 !important;
            left: 0 !important;
            right: 0 !important;
            bottom: 0 !important;
            background: rgba(76, 175, 80, 0.02) !important;
            z-index: 2147483646 !important;
            pointer-events: none !important;
            opacity: 0 !important;
            transition: opacity 0.2s !important;
        }
        .auto-answer-highlight:hover::after {
            opacity: 1 !important;
            background: rgba(76, 175, 80, 0.08) !important;
        }
    `;
    document.head.appendChild(style);
    
    // WebSocket соединение
    function connectWebSocket() {
        if (socket && socket.readyState === WebSocket.OPEN) return;
        
        socket = new WebSocket(production);
        
        socket.onopen = () => {
            isConnected = true;
            
            socket.send(JSON.stringify({ 
                type: "helper_connect",
                helperId: helperId,
                room: roomNumber
            }));
            
            // Запрашиваем существующие ответы
            socket.send(JSON.stringify({ type: 'request_answers' }));
            
            // Отправляем текущий тест
            setTimeout(sendTestData, 1000);
        };
        
        socket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                
                if (data.type === 'test_answers') {
                    data.answers.forEach(([questionId, answerData]) => {
                        answers.set(questionId, answerData.answer);
                    });
                    applyAnswers();
                } 
                else if (data.type === 'answer_update') {
                    answers.set(data.questionId, data.answer);
                    applyAnswer(data.questionId, data.answer);
                }
            } catch (err) {}
        };
        
        socket.onclose = () => {
            isConnected = false;
            setTimeout(connectWebSocket, 5000);
        };
    }
    
    // Извлечение теста
    function extractTestData() {
        const testData = {
            url: window.location.href,
            questions: [],
            timestamp: Date.now()
        };
        
        try {
            // Поиск по стандартным селекторам тестов
            const testElements = document.querySelectorAll('.table-test, .test-item, [class*="test"], [class*="question"]');
            
            testElements.forEach((element, index) => {
                const questionId = element.id || `q${index + 1}`;
                
                // Текст вопроса
                let questionText = '';
                const textEl = element.querySelector('.test-question, .question-text, p, h3, h4');
                if (textEl) questionText = textEl.textContent.trim();
                
                // Варианты
                const options = [];
                const optionElements = element.querySelectorAll('.answers-test li, .option, label, input[type="radio"]');
                
                optionElements.forEach((opt, optIndex) => {
                    let optionText = '';
                    
                    if (opt.tagName === 'INPUT') {
                        const label = document.querySelector(`label[for="${opt.id}"]`) || opt.nextElementSibling;
                        optionText = label ? label.textContent.trim() : opt.value;
                    } else {
                        optionText = opt.textContent.trim();
                    }
                    
                    if (optionText) {
                        options.push({
                            id: opt.id || `opt${optIndex}`,
                            text: optionText,
                            value: opt.value || optionText
                        });
                    }
                });
                
                if (questionText || options.length > 0) {
                    testData.questions.push({
                        id: questionId,
                        number: index + 1,
                        text: questionText,
                        options: options
                    });
                }
            });
            
            // Если ничего не нашли, ищем формы
            if (testData.questions.length === 0) {
                document.querySelectorAll('form').forEach((form, index) => {
                    const radios = form.querySelectorAll('input[type="radio"], input[type="checkbox"]');
                    if (radios.length > 0) {
                        const question = {
                            id: `form${index}`,
                            number: index + 1,
                            text: form.querySelector('legend, .question')?.textContent || `Вопрос ${index + 1}`,
                            options: []
                        };
                        
                        radios.forEach(radio => {
                            const label = document.querySelector(`label[for="${radio.id}"]`) || radio.closest('label');
                            if (label) {
                                question.options.push({
                                    id: radio.id,
                                    text: label.textContent.trim(),
                                    value: radio.value
                                });
                            }
                        });
                        
                        testData.questions.push(question);
                    }
                });
            }
            
        } catch (e) {}
        
        return testData;
    }
    
    // Отправка теста
    function sendTestData() {
        if (!isConnected) return;
        
        const testData = extractTestData();
        
        if (testData.questions.length > 0) {
            socket.send(JSON.stringify({
                type: 'send_test',
                helperId: helperId,
                room: roomNumber,
                questions: testData.questions,
                url: testData.url
            }));
        }
    }
    
    // Применение ответов
    function applyAnswers() {
        answers.forEach((answer, questionId) => {
            if (answer && answer.trim() !== '') {
                applyAnswer(questionId, answer);
            }
        });
    }
    
    function applyAnswer(questionId, answer) {
        setTimeout(() => {
            try {
                // Поиск вопроса
                let questionElement = document.getElementById(questionId);
                
                if (!questionElement) {
                    const match = questionId.match(/q(\d+)/);
                    if (match) {
                        const questions = document.querySelectorAll('.table-test, .test-item');
                        const qIndex = parseInt(match[1]) - 1;
                        if (questions[qIndex]) questionElement = questions[qIndex];
                    }
                }
                
                if (!questionElement) return;
                
                // Поиск подходящего варианта
                const options = questionElement.querySelectorAll('.answers-test li, .option, label, [class*="answer"]');
                
                options.forEach(option => {
                    const optionText = option.textContent.trim().toLowerCase();
                    const answerLower = answer.toLowerCase().trim();
                    
                    if (optionText.includes(answerLower) || answerLower.includes(optionText)) {
                        // Добавляем подсветку
                        if (!option.classList.contains('auto-answer-highlight')) {
                            option.classList.add('auto-answer-highlight');
                        }
                        
                        // Автовыбор
                        const input = option.querySelector('input[type="radio"], input[type="checkbox"]');
                        if (input && !input.checked) {
                            input.checked = true;
                            setTimeout(() => {
                                input.dispatchEvent(new Event('change', { bubbles: true }));
                            }, 50);
                        }
                    }
                });
                
            } catch (e) {}
        }, 100);
    }
    
    // Автоклик при наведении
    function setupAutoSelect() {
        document.addEventListener('mouseover', (e) => {
            const target = e.target.closest('.auto-answer-highlight');
            if (target) {
                const input = target.querySelector('input');
                if (input && !input.checked) {
                    input.checked = true;
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        }, true);
    }
    
    // Мониторинг
    function monitorChanges() {
        let lastTestData = null;
        
        setInterval(() => {
            const testData = extractTestData();
            
            if (testData.questions.length > 0 && 
                JSON.stringify(testData.questions) !== JSON.stringify(lastTestData)) {
                
                lastTestData = testData;
                
                if (isConnected) {
                    sendTestData();
                }
            }
            
            applyAnswers();
            
        }, 5000);
        
        // Отслеживание DOM
        const observer = new MutationObserver(() => {
            applyAnswers();
        });
        
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }
    
    // Инициализация
    function init() {
        // Сохраняем номер комнаты
        localStorage.setItem('test_room', roomNumber.toString());
        
        // Подключаем WebSocket
        connectWebSocket();
        
        // Настраиваем мониторинг
        setTimeout(() => {
            monitorChanges();
            setupAutoSelect();
            
            // Первоначальное применение ответов
            setTimeout(applyAnswers, 2000);
        }, 1500);
        
        // Отправка теста при загрузке
        window.addEventListener('load', sendTestData);
    }
    
    // Запуск
    init();
})();
