(async () => {
    const WS_URL = location.protocol === 'https:' 
        ? 'wss://v1-ai.onrender.com.com' 
        : 'ws://localhost:10000';

    const helperSessionId = `auto-${Date.now()}-${Math.random().toString(36).substr(2,9)}`;
    let clientId = localStorage.getItem('clientId');
    if (!clientId) {
        clientId = `client-${Date.now()}-${Math.random().toString(36).substr(2,9)}`;
        localStorage.setItem('clientId', clientId);
    }

    let socket = null;
    let alreadySent = false; // чтобы не слать одни и те же тесты по 100 раз

    console.log("%cАвто-хелпер запущен", "color: lime; font-size: 16px; font-weight: bold;");
    console.log("Session:", helperSessionId, "| Client:", clientId);

    // === Подключение к WebSocket ===
    function connect() {
        socket = new WebSocket(WS_URL);

        socket.onopen = () => {
            console.log("%cWebSocket подключён", "color: cyan");
            socket.send(JSON.stringify({
                type: "helper_connect",
                role: "auto_helper",
                helperId: helperSessionId,
                clientId,
                url: location.href
            }));
        };

        socket.onclose = socket.onerror = () => {
            console.log("WebSocket разорван — переподключаемся через 3 сек");
            setTimeout(connect, 3000);
        };
    }
    connect();

    // === Основная функция сбора тестов ===
    function collectTests() {
        const tests = [];

        // Поддерживаем оба варианта: один таб или несколько
        document.querySelectorAll('.table-test.tab-pane').forEach((tab, tabIndex) => {
            const tabId = tab.id || `tab-${tabIndex + 1}`;

            // Находим все вопросы в этом табе
            tab.querySelectorAll('.test-question').forEach((qBlock, qIdx) => {
                const questionImg = qBlock.querySelector('p > img')?.src || 
                                   qBlock.querySelector('img')?.src;

                if (!questionImg) return;

                // Баллы (ищем в ближайшем контейнере)
                const pointsEl = tab.querySelector('.label.label-info') || 
                                qBlock.parentElement.querySelector('.label.label-info');
                const points = pointsEl ? parseInt(pointsEl.textContent.replace(/\D/g, '')) || 1 : 1;

                const answers = [];
                const answerItems = tab.querySelectorAll('.answers-test.testing li');

                answerItems.forEach(li => {
                    const radio = li.querySelector('input[type="radio"]');
                    const img = li.querySelector('img');
                    const letter = li.querySelector('.test-variant')?.textContent.trim();

                    if (radio && img?.src && letter) {
                        answers.push({
                            letter,
                            value: radio.value,
                            image: img.src
                        });
                    }
                });

                if (answers.length >= 3) {
                    tests.push({
                        tabId,
                        questionNumber: tests.filter(t => t.tabId === tabId).length + 1,
                        points,
                        questionImage: questionImg,
                        answers
                    });
                }
            });
        });

        return tests;
    }

    // === Отправка на сервер ===
    function sendIfReady() {
        if (alreadySent) return;

        const tests = collectTests();

        if (tests.length === 0) {
            console.log("Тесты ещё не загрузились, ждём...");
            return;
        }

        // Дополнительная проверка: если вопросов больше 5 — точно всё загрузилось
        if (tests.length < 5) {
            console.log(`Найдено только ${tests.length} вопросов, подождём ещё...`);
            return;
        }

        const payload = {
            type: "all_tests_auto",
            helperId: helperSessionId,
            clientId,
            url: location.href,
            title: document.title,
            total: tests.length,
            tests
        };

        if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(payload));
            console.log(`%cУСПЕШНО ОТПРАВЛЕНО ${tests.length} ВОПРОСОВ!`, "color: gold; font-size: 18px; font-weight: bold;");
            alreadySent = true; // больше не шлём с этой страницы
        }
    }

    // === Автоматический запуск через несколько секунд + наблюдатель за изменениями ===
    let attempts = 0;
    const maxAttempts = 30; // максимум 30 × 2 сек = 1 минута ожидания

    const timer = setInterval(() => {
        attempts++;
        sendIfReady();

        if (alreadySent || attempts >= maxAttempts) {
            clearInterval(timer);
            if (!alreadySent) {
                console.log("%cВремя вышло — тесты так и не появились", "color: red");
            }
        }
    }, 2000);

    // Дополнительно: если контент подгружается динамически (через AJAX)
    const observer = new MutationObserver(() => {
        if (!alreadySent) {
            console.log("Обнаружены изменения на странице — проверяем тесты...");
            sendIfReady();
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: false
    });

    // === Отключение бана (на всякий случай оставляем) ===
    const disableBan = () => {
        document.querySelectorAll('.js-banned-screen').forEach(el => el.remove());

        const orig = window.Audio;
        window.Audio = function(src) {
            if (src?.includes('beep')) return { play: () => {} };
            return new orig(src);
        };

        new MutationObserver(muts => {
            muts.forEach(m => m.addedNodes.forEach(node => {
                if (node.classList?.contains('js-banned-screen')) node.remove();
            }));
        }).observe(document.body, { childList: true, subtree: true });
    };
    disableBan();

    console.log("%cХелпер работает в фоновом режиме. Ждёт появления тестов и отправит автоматически.", "color: lightgreen; font-style: italic;");
})();
