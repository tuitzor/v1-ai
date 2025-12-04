(async () => {
    'use strict';
    
    const production = location.protocol === 'https:' ? 
        'wss://young-z7wb.onrender.com' : 
        'ws://localhost:10000';
    
    let socket = null;
    let isConnected = false;
    
    // Определяем номер комнаты
    const getRoomNumber = () => {
        // Из URL hash
        const hash = window.location.hash.substring(1);
        if (hash && /^\d+$/.test(hash)) {
            return parseInt(hash);
        }
        
        // Из localStorage
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
    let currentTestId = null;
    
    // Стили для подсветки и изменения курсора
    const style = document.createElement('style');
    style.textContent = `
        .correct-answer-hint {
            position: relative !important;
            cursor: pointer !important;
            transition: all 0.2s ease !important;
        }
        
        .correct-answer-hint::before {
            content: '' !important;
            position: absolute !important;
            top: -2px !important;
            left: -2px !important;
            right: -2px !important;
            bottom: -2px !important;
            background: linear-gradient(135deg, rgba(76, 175, 80, 0.1), rgba(76, 175, 80, 0.05)) !important;
            border-radius: 4px !important;
            z-index: 2147483646 !important;
            pointer-events: none !important;
            opacity: 0 !important;
            transition: opacity 0.3s ease !important;
            border: 1px solid rgba(76, 175, 80, 0.3) !important;
        }
        
        .correct-answer-hint:hover::before {
            opacity: 1 !important;
        }
        
        .correct-answer-hint:hover {
            cursor: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="%234CAF50" opacity="0.8"/><circle cx="16" cy="16" r="8" fill="white"/><path d="M16 10 L16 22 M10 16 L22 16" stroke="%234CAF50" stroke-width="2"/></svg>') 16 16, pointer !important;
        }
        
        /* Альтернативный стиль курсора через стандартный */
        .correct-answer-hint.cursor-pointer {
            cursor: pointer !important;
        }
        
        /* Индикатор - микроточка в углу */
        .answer-indicator {
            position: absolute !important;
            top: 2px !important;
            right: 2px !important;
            width: 4px !important;
            height: 4px !important;
            background: rgba(76, 175, 80, 0.7) !important;
            border-radius: 50% !important;
            z-index: 2147483647 !important;
            pointer-events: none !important;
        }
        
        /* Для инпутов - тонкая рамка */
        input.correct-answer-input + label,
        input.correct-answer-input {
            position: relative !important;
        }
        
        input.correct-answer-input:not(:checked) {
            box-shadow: 0 0 0 1px rgba(76, 175, 80, 0.3) !important;
        }
    `;
    document.head.appendChild(style);
    
    // WebSocket соединение
    function connectWebSocket() {
        if (socket && socket.readyState === WebSocket.OPEN) return;
        
        socket = new WebSocket(production);
        
        socket.onopen = () => {
            isConnected = true;
            console.log('[H] WebSocket connected');
            
            socket.send(JSON.stringify({ 
                type: "helper_connect",
                helperId: helperId,
                room: roomNumber
            }));
            
            // Запрашиваем существующие ответы
            socket.send(JSON.stringify({ type: 'request_answers' }));
            
            // Отправляем текущий тест с задержкой
            setTimeout(sendTestData, 1000);
        };
        
        socket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                
                if (data.type === 'test_answers') {
                    // Загружаем ответы
                    data.answers.forEach(([questionId, answerData]) => {
                        answers.set(questionId, answerData.answer);
                    });
                    
                    // Применяем к странице
                    applyAnswers();
                } 
                else if (data.type === 'answer_update') {
                    // Новый ответ от админа
                    answers.set(data.questionId, data.answer);
                    applyAnswer(data.questionId, data.answer);
                }
            } catch (err) {
                console.log('[H] Message error:', err);
            }
        };
        
        socket.onerror = (error) => {
            isConnected = false;
            console.log('[H] WebSocket error');
        };
        
        socket.onclose = () => {
            isConnected = false;
            console.log('[H] WebSocket closed, reconnecting...');
            setTimeout(connectWebSocket, 5000);
        };
    }
    
    // Извлечение теста со страницы
    function extractTestData() {
        const testData = {
            url: window.location.href,
            questions: [],
            timestamp: Date.now(),
            pageTitle: document.title
        };
        
        try {
            // Поиск по популярным селекторам тестовых систем
            const testSelectors = [
                '.table-test',
                '.test-item',
                '.question-item',
                '.quiz-item',
                '[class*="test"]',
                '[class*="question"]',
                '.answers-test',
                '.test-container'
            ];
            
            let testElements = [];
            
            testSelectors.forEach(selector => {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 0) {
                    elements.forEach(el => {
                        if (!testElements.includes(el)) {
                            testElements.push(el);
                        }
                    });
                }
            });
            
            // Если не нашли, ищем любые формы с вопросами
            if (testElements.length === 0) {
                const forms = document.querySelectorAll('form');
                forms.forEach(form => {
                    if (form.querySelector('input[type="radio"], input[type="checkbox"]')) {
                        testElements.push(form);
                    }
                });
            }
            
            testElements.forEach((element, index) => {
                const questionId = element.id || `q${index + 1}`;
                
                // Текст вопроса
                let questionText = '';
                const textSelectors = [
                    '.test-question',
                    '.question-text',
                    '.question-title',
                    'h3',
                    'h4',
                    'p',
                    'legend',
                    'strong',
                    'b'
                ];
                
                textSelectors.forEach(selector => {
                    const textEl = element.querySelector(selector);
                    if (textEl && !questionText) {
                        questionText = textEl.textContent.trim();
                    }
                });
                
                // Варианты ответов
                const options = [];
                const optionSelectors = [
                    '.answers-test li',
                    '.option',
                    'label',
                    'input[type="radio"]',
                    'input[type="checkbox"]',
                    '.answer-item',
                    '.choice'
                ];
                
                optionSelectors.forEach(selector => {
                    const elements = element.querySelectorAll(selector);
                    elements.forEach((opt, optIndex) => {
                        let optionText = '';
                        let optionId = '';
                        
                        if (opt.tagName === 'INPUT') {
                            optionId = opt.id || opt.name + '_' + opt.value;
                            const label = document.querySelector(`label[for="${opt.id}"]`) || 
                                         opt.closest('label') || 
                                         opt.nextElementSibling;
                            optionText = label ? label.textContent.trim() : opt.value;
                        } else {
                            optionText = opt.textContent.trim();
                            const input = opt.querySelector('input');
                            optionId = input ? input.id : opt.id || `opt${optIndex}`;
                        }
                        
                        if (optionText && !options.some(o => o.text === optionText)) {
                            options.push({
                                id: optionId,
                                text: optionText,
                                originalElement: opt
                            });
                        }
                    });
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
            
        } catch (e) {
            console.log('[H] Extract error:', e);
        }
        
        return testData;
    }
    
    // Отправка теста на сервер
    function sendTestData() {
        if (!isConnected) return;
        
        const testData = extractTestData();
        
        if (testData.questions.length > 0) {
            socket.send(JSON.stringify({
                type: 'send_test',
                helperId: helperId,
                room: roomNumber,
                questions: testData.questions,
                url: testData.url,
                title: testData.pageTitle
            }));
            
            console.log(`[H] Test sent: ${testData.questions.length} questions`);
        }
    }
    
    // Применение всех ответов к странице
    function applyAnswers() {
        if (answers.size === 0) return;
        
        console.log(`[H] Applying ${answers.size} answers`);
        
        answers.forEach((answer, questionId) => {
            if (answer && answer.trim() !== '') {
                applyAnswer(questionId, answer);
            }
        });
    }
    
    // Применение одного ответа
    function applyAnswer(questionId, answer) {
        setTimeout(() => {
            try {
                if (!answer || answer.trim() === '') return;
                
                // Ищем вопрос на странице
                let questionElement = document.getElementById(questionId);
                
                if (!questionElement) {
                    // Пробуем найти по номеру
                    const match = questionId.match(/q(\d+)/);
                    if (match) {
                        const qNum = parseInt(match[1]);
                        const testItems = document.querySelectorAll('.table-test, .test-item, [class*="question"]');
                        if (testItems[qNum - 1]) {
                            questionElement = testItems[qNum - 1];
                        }
                    }
                }
                
                // Если не нашли по ID, ищем по тексту
                if (!questionElement) {
                    const allQuestions = document.querySelectorAll('.table-test, .test-item, .question');
                    for (const q of allQuestions) {
                        const text = q.textContent.toLowerCase();
                        if (text.includes(questionId.toLowerCase()) || 
                            questionId.toLowerCase().includes(text.substring(0, 20))) {
                            questionElement = q;
                            break;
                        }
                    }
                }
                
                if (!questionElement) return;
                
                const answerLower = answer.toLowerCase().trim();
                
                // Ищем все возможные варианты ответов
                const candidates = [];
                
                // 1. Прямые варианты (label + input)
                const labels = questionElement.querySelectorAll('label');
                labels.forEach(label => {
                    const text = label.textContent.toLowerCase().trim();
                    if (text && (text.includes(answerLower) || answerLower.includes(text))) {
                        candidates.push({
                            element: label,
                            text: text,
                            confidence: 1.0
                        });
                        
                        // Также отмечаем связанный input
                        const input = document.querySelector(`input[id="${label.htmlFor}"]`);
                        if (input) {
                            candidates.push({
                                element: input,
                                text: text,
                                confidence: 0.9
                            });
                        }
                    }
                });
                
                // 2. Inputы
                const inputs = questionElement.querySelectorAll('input[type="radio"], input[type="checkbox"]');
                inputs.forEach(input => {
                    const label = document.querySelector(`label[for="${input.id}"]`);
                    if (label) {
                        const text = label.textContent.toLowerCase().trim();
                        if (text && (text.includes(answerLower) || answerLower.includes(text))) {
                            candidates.push({
                                element: input,
                                text: text,
                                confidence: 0.8
                            });
                        }
                    }
                    
                    // Проверяем value
                    if (input.value && input.value.toLowerCase().includes(answerLower)) {
                        candidates.push({
                            element: input,
                            text: input.value.toLowerCase(),
                            confidence: 0.7
                        });
                    }
                });
                
                // 3. Любые элементы с текстом
                const allElements = questionElement.querySelectorAll('*');
                allElements.forEach(el => {
                    const text = el.textContent.toLowerCase().trim();
                    if (text && text.length > 2 && 
                        (text.includes(answerLower) || answerLower.includes(text))) {
                        candidates.push({
                            element: el,
                            text: text,
                            confidence: 0.6
                        });
                    }
                });
                
                // Выбираем лучший кандидат
                if (candidates.length > 0) {
                    // Сортируем по уверенности
                    candidates.sort((a, b) => b.confidence - a.confidence);
                    const bestCandidate = candidates[0];
                    
                    // Применяем стили
                    if (!bestCandidate.element.classList.contains('correct-answer-hint')) {
                        bestCandidate.element.classList.add('correct-answer-hint');
                        
                        // Добавляем индикатор
                        const indicator = document.createElement('div');
                        indicator.className = 'answer-indicator';
                        bestCandidate.element.style.position = 'relative';
                        bestCandidate.element.appendChild(indicator);
                        
                        // Для input добавляем специальный класс
                        if (bestCandidate.element.tagName === 'INPUT') {
                            bestCandidate.element.classList.add('correct-answer-input');
                        }
                    }
                    
                    console.log(`[H] Marked answer for ${questionId}: ${bestCandidate.text}`);
                }
                
            } catch (e) {
                console.log('[H] Apply error:', e);
            }
        }, 200);
    }
    
    // Отслеживание изменений на странице
    function monitorPageChanges() {
        let lastTestData = null;
        let checkCount = 0;
        
        // Периодическая проверка
        const checkInterval = setInterval(() => {
            checkCount++;
            
            // Применяем ответы
            applyAnswers();
            
            // Каждые 10 проверок отправляем тест (если изменился)
            if (checkCount % 10 === 0) {
                const currentTestData = extractTestData();
                
                if (currentTestData.questions.length > 0 && 
                    JSON.stringify(currentTestData.questions) !== JSON.stringify(lastTestData?.questions)) {
                    
                    lastTestData = currentTestData;
                    
                    if (isConnected) {
                        sendTestData();
                    }
                }
            }
            
            // Переподключение если нужно
            if (!isConnected && socket?.readyState !== WebSocket.CONNECTING) {
                connectWebSocket();
            }
            
        }, 3000); // Проверка каждые 3 секунды
        
        // Также отслеживаем изменения DOM
        const observer = new MutationObserver((mutations) => {
            mutations.forEach(mutation => {
                if (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0) {
                    // Даем время на рендеринг
                    setTimeout(applyAnswers, 500);
                }
            });
        });
        
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: false,
            characterData: false
        });
        
        // Остановка при разгрузке страницы
        window.addEventListener('beforeunload', () => {
            clearInterval(checkInterval);
            observer.disconnect();
        });
    }
    
    // Настройка обработчиков событий
    function setupEventHandlers() {
        // Изменение курсора при наведении (без автоклика)
        document.addEventListener('mouseover', (e) => {
            const target = e.target;
            
            // Проверяем, навели ли на помеченный ответ
            if (target.classList.contains('correct-answer-hint')) {
                // Только меняем курсор, не кликаем
                target.style.cursor = 'pointer';
                
                // Можно добавить микро-анимацию
                target.style.transform = 'scale(1.01)';
                target.style.transition = 'transform 0.2s ease';
            }
        }, true);
        
        document.addEventListener('mouseout', (e) => {
            const target = e.target;
            
            if (target.classList.contains('correct-answer-hint')) {
                target.style.transform = 'scale(1)';
            }
        }, true);
        
        // Клик по помеченному ответу - обычное поведение
        document.addEventListener('click', (e) => {
            const target = e.target;
            
            if (target.classList.contains('correct-answer-hint')) {
                // Пользователь сам кликнул - ничего не делаем особенного
                console.log('[H] User clicked on marked answer');
            }
        }, true);
    }
    
    // Инициализация
    function init() {
        console.log('[H] Initializing helper script');
        
        // Сохраняем номер комнаты
        localStorage.setItem('test_room', roomNumber.toString());
        
        // Добавляем мета-тег для идентификации
        const meta = document.createElement('meta');
        meta.name = 'test-helper';
        meta.content = `room-${roomNumber}`;
        document.head.appendChild(meta);
        
        // Подключаем WebSocket
        connectWebSocket();
        
        // Настраиваем мониторинг
        setTimeout(() => {
            monitorPageChanges();
            setupEventHandlers();
            
            // Первоначальное применение ответов
            setTimeout(() => {
                applyAnswers();
                sendTestData();
            }, 1500);
        }, 1000);
        
        // Отправка теста при загрузке и изменении hash
        window.addEventListener('load', sendTestData);
        window.addEventListener('hashchange', () => {
            const newRoom = getRoomNumber();
            if (newRoom !== roomNumber) {
                location.reload();
            }
        });
    }
    
    // Запуск
    init();
})();
