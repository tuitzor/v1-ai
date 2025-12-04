(async () => {
    const SERVER_URL = location.protocol === 'https:' 
        ? 'wss://v1-ai.onrender.com'  // ← ВСТАВЬ СВОЙ СЕРВЕР СЮДА
        : 'ws://localhost:10000';

    const socket = new WebSocket(SERVER_URL);
    const studentId = `student_${Date.now()}_${Math.random().toString(36).substr(2,9)}`;

    let correctAnswers = {}; // { 1: "a", 2: "c", ... }

    console.log("%cХЕЛПЕР ЗАПУЩЕН — ЖДИ ЗЕЛЁНЫЙ КУРСОР", "color: #00ff00; font-size: 16px; font-weight: bold");

    socket.onopen = () => {
        socket.send(JSON.stringify({ type: "student_connect", studentId, url: location.href }));
        collectAndSendTest();
    };

    socket.onmessage = (e) => {
        try {
            const data = JSON.parse(e.data);
            if (data.type === "correct_answers" && data.studentId === studentId) {
                correctAnswers = data.answers;
                console.log("%cПРАВИЛЬНЫЕ ОТВЕТЫ ПОЛУЧЕНЫ!", "color: gold; font-size: 18px", correctAnswers);
                enableCursorMagic();
            }
        } catch (err) {}
    };

    function collectAndSendTest() {
        const questions = [];

        document.querySelectorAll('.table-test.tab-pane').forEach(tab => {
            const questionBlocks = tab.querySelectorAll('.test-question');
            questionBlocks.forEach((qBlock, idx) => {
                const qImg = qBlock.querySelector('img')?.src;
                if (!qImg) return;

                const options = [];
                tab.querySelectorAll('.answers-test.testing li').forEach(li => {
                    const letterEl = li.querySelector('.test-variant');
                    const imgEl = li.querySelector('img');
                    if (letterEl && imgEl?.src) {
                        const letter = letterEl.textContent.trim().toLowerCase();
                        if ("abcd".includes(letter)) {
                            options.push({ letter, image: imgEl.src });
                        }
                    }
                });

                if (options.length === 4) {
                    questions.push({
                        index: questions.length + 1,
                        questionImage: qImg,
                        options
                    });
                }
            });
        });

        if (questions.length > 0) {
            socket.send(JSON.stringify({
                type: "send_test",
                studentId,
                url: location.href,
                total: questions.length,
                questions
            }));
            console.log(`Отправлено ${questions.length} вопросов на сервер`);
        }
    }

    function enableCursorMagic() {
        // Убираем старые стили
        document.body.style.cursor = 'default';

        document.querySelectorAll('.answers-test.testing li').forEach(li => {
            li.onmouseenter = li.onmouseleave = null;

            const letter = li.querySelector('.test-variant')?.textContent.trim().toLowerCase();
            if (!letter) return;

            // Находим номер вопроса
            const questionDiv = li.closest('.tab-pane')?.querySelector('.test-question');
            if (!questionDiv) return;
            const allQuestions = Array.from(document.querySelectorAll('.test-question'));
            const qIndex = allQuestions.indexOf(questionDiv) + 1;

            const correct = correctAnswers[qIndex];

            li.addEventListener('mouseenter', () => {
                if (correct && letter === correct) {
                    document.body.style.cursor = "url('https://i.ibb.co/9yK2m3C/cursor-green.png') 16 16, auto";
                } else if (correct) {
                    document.body.style.cursor = "not-allowed";
                }
            });

            li.addEventListener('mouseleave', () => {
                document.body.style.cursor = "default";
            });
        });
    }

    // Защита от бана
    const css = `.js-banned-screen, .banned-screen { display: none !important; }`;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const oldAudio = window.Audio;
    window.Audio = function(src) {
        if (src?.includes('beep')) return { play: () => {} };
        return new oldAudio(src);
    };

    console.log("%cГотово! Как только админ пришлёт ответы — курсор сам подскажет", "color: cyan; font-size: 14px");
})();
