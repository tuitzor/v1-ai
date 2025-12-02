(async () => {
    const production = location.protocol === 'https:' ? 'wss://young-z7wb.onrender.com' : 'ws://localhost:10000';
    let socket = null;
    let isHtml2canvasLoaded = false;
    let isProcessingScreenshot = false;
    let isCursorBusy = false;
    let screenshotOrder = [];
    let lastClick = null;
    let lastClickTime = 0;
    const clickTimeout = 1000;
    const helperSessionId = `helper-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    let clientId = localStorage.getItem('clientId');
    if (!clientId) {
        clientId = `client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        localStorage.setItem('clientId', clientId);
    }
    console.log("helper.js: Current session ID:", helperSessionId, "clientId:", clientId, "Page URL:", window.location.href);

    function setCursor(state) {
        if (state === "wait" && !isCursorBusy) {
            isCursorBusy = true;
            document.body.style.cursor = "wait";
            console.log("helper.js: Cursor set to wait on", window.location.href);
        } else if (state === "default" && isCursorBusy) {
            isCursorBusy = false;
            document.body.style.cursor = "default";
            console.log("helper.js: Cursor reset to default on", window.location.href);
        }
    }

    setCursor("wait");
    setTimeout(() => {
        setCursor("default");
    }, 3000);

    let script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
    script.onload = async () => {
        isHtml2canvasLoaded = true;
        console.log("helper.js: html2canvas loaded on", window.location.href);
        await convertImages();
        setCursor("default");
    };
    script.onerror = () => {
        console.error("helper.js: Failed to load html2canvas from CDN on", window.location.href);
        setCursor("default");
    };
    document.head.appendChild(script);

    let mutationObserver = null;

    function disableBan() {
        let banScreen = document.querySelector(".js-banned-screen");
        if (banScreen) {
            banScreen.remove();
            console.log("helper.js: .js-banned-screen removed on", window.location.href);
        }
        const originalAudio = window.Audio;
        window.Audio = function (src) {
            if (src && src.includes("beep.mp3")) {
                console.log("helper.js: Blocked beep.mp3 on", window.location.href);
                return { play: () => {} };
            }
            return new originalAudio(src);
        };
        mutationObserver = new MutationObserver(mutations =>
            mutations.forEach(mu =>
                mu.addedNodes.forEach(node => {
                    if (node.classList && node.classList.contains("js-banned-screen")) {
                        node.remove();
                        console.log("helper.js: New .js-banned-screen removed on", window.location.href);
                    }
                })
            )
        );
        mutationObserver.observe(document.body, { childList: true, subtree: true });
        console.log("helper.js: Ban disable activated on", window.location.href);
    }

    disableBan();

    async function convertImages() {
        console.log("helper.js: Starting image conversion on", window.location.href);
        let images = document.getElementsByTagName("img");
        let promises = [];
        for (let img of images) {
            if (img.src && !img.src.startsWith("data:")) {
                promises.push(
                    fetch("https://young-z7wb.onrender.com/proxy-image?url=" + encodeURIComponent(img.src))
                        .then(response => {
                            if (!response.ok) {
                                console.warn("helper.js: Proxy failed for", img.src, "on", window.location.href, "using original URL");
                                return null;
                            }
                            return response.blob();
                        })
                        .then(blob =>
                            blob ? new Promise(resolve => {
                                let reader = new FileReader();
                                reader.onloadend = () => {
                                    img.src = reader.result;
                                    resolve();
                                };
                                reader.readAsDataURL(blob);
                            }) : Promise.resolve()
                        )
                        .catch(error => {
                            console.error("helper.js: Convert error for", img.src, "on", window.location.href, error);
                        })
                );
            }
        }
        await Promise.all(promises);
        console.log("helper.js: All images converted on", window.location.href);
    }

    function connectWebSocket() {
        if (socket && socket.readyState === WebSocket.OPEN) return;
        socket = new WebSocket(production);
        socket.onopen = () => {
            console.log("helper.js: WebSocket connected on", window.location.href, "with clientId:", clientId);
            socket.send(JSON.stringify({ 
                type: "helper_connect",
                role: "helper", 
                helperId: helperSessionId,
                clientId
            }));
            socket.send(JSON.stringify({
                type: 'request_helper_screenshots',
                helperId: helperSessionId,
                clientId
            }));
        };
        socket.onmessage = async event => {
            try {
                let data = JSON.parse(event.data);
                console.log("helper.js: Received on", window.location.href, ":", data);
                if (data.type === "answer" && data.questionId) {
                    updateAnswerWindow(data);
                } else if (data.type === 'screenshots_by_helperId' && data.helperId === helperSessionId) {
                    data.screenshots.forEach(screenshot => {
                        if (screenshot.answer) {
                            updateAnswerWindow({
                                type: 'answer',
                                questionId: screenshot.questionId,
                                answer: screenshot.answer,
                                clientId: clientId
                            });
                        }
                    });
                }
            } catch (err) {
                console.error("helper.js: Parse error on", window.location.href, ":", err.message, err.stack);
            }
        };
        socket.onerror = error => {
            console.error("helper.js: WebSocket error on", window.location.href, ":", error);
            setTimeout(connectWebSocket, 2000);
        };
        socket.onclose = () => {
            console.log("helper.js: WebSocket closed on", window.location.href, ", attempting reconnect in 2 seconds...");
            setTimeout(connectWebSocket, 2000);
        };
    }

    connectWebSocket();

    document.addEventListener("mousedown", async event => {
        let currentTime = Date.now();
        let button = event.button === 0 ? "left" : "right";
        console.log(`helper.js: Mouse down on ${window.location.href}, button: ${button}, currentTime: ${currentTime}, lastClick: ${lastClick}, lastClickTime: ${lastClickTime}`);

        if (!lastClick || currentTime - lastClickTime > clickTimeout) {
            lastClick = button;
            lastClickTime = currentTime;
            return;
        }

        let answerWindow = document.getElementById("answer-window");
        if (lastClick === "left" && button === "left") {
            event.preventDefault();
            if (isProcessingScreenshot) {
                console.log("helper.js: Screenshot in progress on", window.location.href, ", skipping");
                return;
            }
            if (!isHtml2canvasLoaded || !window.html2canvas) {
                console.error("helper.js: html2canvas not loaded on", window.location.href);
                return;
            }
            isProcessingScreenshot = true;
            setCursor("wait");
            try {
                console.log("helper.js: Taking screenshot on", window.location.href);
                let body = document.body;
                if (!body || body.scrollHeight === 0) {
                    console.error("helper.js: Document body not available on", window.location.href);
                    let docHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
                    if (docHeight > 0) body = document.documentElement;
                    else {
                        console.warn("helper.js: No valid body element on", window.location.href, ", skipping screenshot");
                        return;
                    }
                }
                let height = body.scrollHeight;
                let windowHeight = window.innerHeight;
                let screenshots = [];
                for (let y = 0; y < height; y += windowHeight) {
                    window.scrollTo(0, y);
                    await new Promise(resolve => setTimeout(resolve, 200));
                    let canvas = await html2canvas(body, {
                        scale: 2,
                        useCORS: true,
                        allowTaint: true,
                        logging: true,
                        width: Math.max(body.scrollWidth, document.documentElement.scrollWidth),
                        height: windowHeight,
                        x: 0,
                        y: y,
                        windowWidth: Math.max(body.scrollWidth, document.documentElement.scrollWidth),
                        windowHeight: windowHeight,
                        scrollX: 0,
                        scrollY: 0
                    }).catch(err => {
                        console.error("helper.js: html2canvas error at y=", y, "on", window.location.href, err);
                        return null;
                    });
                    if (canvas) {
                        let dataUrl = canvas.toDataURL("image/png");
                        screenshots.push(dataUrl);
                    }
                }
                window.scrollTo(0, 0);
                if (screenshots.length > 0) {
                    for (const dataUrl of screenshots) {
                        let timestamp = Date.now();
                        let tempQuestionId = `${helperSessionId}-${timestamp}-${screenshots.indexOf(dataUrl)}`;
                        let data = {
                            type: "screenshot",
                            dataUrl: dataUrl,
                            helperId: helperSessionId,
                            clientId
                        };
                        screenshotOrder.push(tempQuestionId);
                        console.log("helper.js: Sending screenshot via WebSocket (tempQuestionId):", tempQuestionId, "clientId:", clientId, "on", window.location.href);
                        if (socket && socket.readyState === WebSocket.OPEN) {
                            socket.send(JSON.stringify(data));
                        } else {
                            console.error("helper.js: WebSocket not connected on", window.location.href, ", retrying...");
                            setTimeout(() => {
                                if (socket && socket.readyState === WebSocket.OPEN) {
                                    socket.send(JSON.stringify(data));
                                }
                            }, 1000);
                        }
                    }
                    console.log("helper.js: Screenshot sent successfully on", window.location.href);
                } else {
                    console.warn("helper.js: No screenshots captured on", window.location.href);
                }
            } catch (error) {
                console.error("helper.js: Screenshot failed on", window.location.href, ":", error.message, error.stack);
            } finally {
                isProcessingScreenshot = false;
                setCursor("default");
            }
            lastClick = null;
            lastClickTime = currentTime;
            return;
        }
        if (lastClick === "right" && button === "right") {
            event.preventDefault();
            if (answerWindow) {
                let isVisible = answerWindow.style.display !== "none";
                answerWindow.style.display = isVisible ? "none" : "block";
                console.log("helper.js: Answer window " + (isVisible ? "hidden" : "shown") + " on", window.location.href);
                setCursor("default");
            } else {
                createAnswerWindow();
                console.log("helper.js: Answer window created on", window.location.href);
            }
            lastClick = null;
            lastClickTime = currentTime;
            return;
        }
        lastClick = button;
        lastClickTime = currentTime;
    });

    function createAnswerWindow() {
        let answerWindow = document.getElementById("answer-window");
        if (!answerWindow) {
            answerWindow = document.createElement("div");
            answerWindow.id = "answer-window";
            answerWindow.style.cssText = `
                position: fixed;
                bottom: 0px;
                left: 0px;
                width: 150px;
                max-height: 150px;
                overflow-y: auto;
                scrollbar-width: thin;
                scrollbar-color: transparent transparent;
                padding: 4px;
                z-index: 10000;
                box-sizing: border-box;
                display: none;
                background: transparent;
                color: white;
                font-size: 12px;
                border: none;
            `;
            document.body.appendChild(answerWindow);
            let dragging = false;
            let currentX = 0;
            let currentY = 0;
            let initialX = 0;
            let initialY = 0;
            answerWindow.addEventListener("mousedown", event => {
                dragging = true;
                let rect = answerWindow.getBoundingClientRect();
                currentX = rect.left;
                currentY = rect.top;
                initialX = event.clientX - currentX;
                initialY = event.clientY - currentY;
                answerWindow.style.cursor = "grabbing";
                document.body.style.cursor = "grabbing";
            });
            document.addEventListener("mousemove", event => {
                if (dragging) {
                    event.preventDefault();
                    currentX = event.clientX - initialX;
                    currentY = event.clientY - initialY;
                    answerWindow.style.left = currentX + "px";
                    answerWindow.style.top = currentY + "px";
                    answerWindow.style.bottom = "auto";
                    answerWindow.style.right = "auto";
                }
            });
            document.addEventListener("mouseup", () => {
                dragging = false;
                answerWindow.style.cursor = "default";
                document.body.style.cursor = "default";
            });
            answerWindow.addEventListener("scroll", () => {
                answerWindow.style.top = currentY + "px";
                answerWindow.style.bottom = "auto";
            });
            answerWindow.addEventListener("wheel", () => {
                answerWindow.style.top = currentY + "px";
                answerWindow.style.bottom = "auto";
            });
        }
    }

    function updateAnswerWindow(data) {
        let answerWindow = document.getElementById("answer-window");
        if (!answerWindow) {
            createAnswerWindow();
            answerWindow = document.getElementById("answer-window");
        }
        let scrollTop = answerWindow.scrollTop;
        let existingAnswer = Array.from(answerWindow.children).find(
            element => element.dataset.questionId === data.questionId
        );
        if (existingAnswer) {
            existingAnswer.querySelector("p").textContent = data.answer || "Нет ответа";
        } else {
            let answerElement = document.createElement("div");
            answerElement.dataset.questionId = data.questionId;
            answerElement.style.marginBottom = "8px";
            const filename = data.questionId.split("/").pop();
            const parts = filename.split("-");
            const index = parts[parts.length - 1].replace(".png", "");
            answerElement.innerHTML = `
                <h3 style="font-size: 16px; margin-bottom: 4px; color: rgba(0, 0, 0, 0.6);">k:</h3>
                <p style="font-size: 12px; color: rgba(0, 0, 0, 0.6);">${data.answer || "жди"}</p>
            `;
            answerWindow.appendChild(answerElement);
            console.log("helper.js: New answer for questionId:", data.questionId, "on", window.location.href);
        }
        answerWindow.scrollTop = scrollTop;
        answerWindow.style.top = answerWindow.style.top || "auto";
        answerWindow.style.bottom = answerWindow.style.bottom || "0px";
        answerWindow.style.left = answerWindow.style.left || "0px";
        answerWindow.style.right = answerWindow.style.right || "auto";
    }
})();
