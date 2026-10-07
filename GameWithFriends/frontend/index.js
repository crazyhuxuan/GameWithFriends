const authView = document.getElementById("authView");
const gamesView = document.getElementById("gamesView");
const billiardsView = document.getElementById("billiardsView");
const userBar = document.getElementById("userBar");
const currentUser = document.getElementById("currentUser");
const authForm = document.getElementById("authForm");
const authStatus = document.getElementById("authStatus");
const passwordInput = document.getElementById("password");
const gameStatus = document.getElementById("gameStatus");
const roomActionStatus = document.getElementById("roomActionStatus");
const roomStatus = document.getElementById("roomStatus");
const adminLoginForm = document.getElementById("adminLoginForm");
const adminLoginStatus = document.getElementById("adminLoginStatus");
const createAccountForm = document.getElementById("createAccountForm");
const createAccountStatus = document.getElementById("createAccountStatus");
const adminConsole = document.getElementById("adminConsole");
const roomActions = document.getElementById("roomActions");
const roomPanel = document.getElementById("roomPanel");
let roomPollTimer = null;
let roomRefreshInFlight = false;
let currentRoom = null;
let currentUsername = "";
const scoreDrafts = new Map();
const ROOM_POLL_INTERVAL_MS = 100;

function showUserLogin() {
    document.getElementById("authHeading").classList.remove("hidden");
    authForm.classList.remove("hidden");
    adminLoginForm.classList.add("hidden");
    adminConsole.classList.add("hidden");
    document.getElementById("adminLoginLink").classList.remove("hidden");
    userBar.classList.add("hidden");
    authStatus.textContent = "";
    adminLoginStatus.textContent = "";
}

function showAdminLogin() {
    document.getElementById("authHeading").classList.add("hidden");
    authForm.classList.add("hidden");
    adminLoginForm.classList.remove("hidden");
    adminConsole.classList.add("hidden");
    document.getElementById("adminLoginLink").classList.add("hidden");
    userBar.classList.add("hidden");
    adminLoginStatus.textContent = "";
}

function showAdminConsole(username) {
    currentUsername = username;
    currentUser.textContent = username;
    authView.classList.remove("hidden");
    document.getElementById("authHeading").classList.add("hidden");
    gamesView.classList.add("hidden");
    billiardsView.classList.add("hidden");
    authForm.classList.add("hidden");
    adminLoginForm.classList.add("hidden");
    document.getElementById("adminLoginLink").classList.add("hidden");
    adminConsole.classList.remove("hidden");
    userBar.classList.remove("hidden");
    createAccountStatus.textContent = "";
}

async function request(path, options = {}) {
    const response = await fetch(path, {
        ...options,
        headers: { "Content-Type": "application/json", ...options.headers }
    });
    const result = await response.json();
    if (!response.ok) {
        const error = new Error(result.error || "请求失败，请稍后再试。");
        error.status = response.status;
        throw error;
    }
    return result;
}

function stopRoomPolling() {
    if (roomPollTimer !== null) {
        window.clearInterval(roomPollTimer);
        roomPollTimer = null;
    }
}

function showGames(username = currentUsername) {
    stopRoomPolling();
    currentRoom = null;
    scoreDrafts.clear();
    currentUsername = username;
    currentUser.textContent = username;
    authView.classList.add("hidden");
    billiardsView.classList.add("hidden");
    gamesView.classList.remove("hidden");
    userBar.classList.remove("hidden");
    gameStatus.textContent = "";
}

function showBilliardsMenu() {
    stopRoomPolling();
    currentRoom = null;
    scoreDrafts.clear();
    gamesView.classList.add("hidden");
    billiardsView.classList.remove("hidden");
    roomActions.classList.remove("hidden");
    roomPanel.classList.add("hidden");
    document.getElementById("backToGames").classList.remove("hidden");
    document.getElementById("billiardsHeading").innerHTML = "来一场<span>台球对决</span>";
    document.getElementById("billiardsDescription").textContent =
        "创建房间邀请好友，或输入房间号加入一场游戏。";
    roomActionStatus.textContent = "";
}

function appendCard(container, card, pottedNumbers, canToggle) {
    const element = document.createElement("button");
    const isPocketed = pottedNumbers.has(card.number);
    element.type = "button";
    element.className = `playing-card${/[♥♦]/u.test(card.label) ? " red-card" : ""}${isPocketed ? " pocketed" : ""}`;
    element.dataset.cardLabel = card.label;
    element.disabled = !canToggle;
    element.setAttribute(
        "aria-label",
        `${card.label}，台球 ${card.number} 号，${isPocketed ? "已进球，点击可撤销" : "未进球，点击标记进球"}`
    );
    element.title = isPocketed ? "已进球，点击撤销" : "未进球，点击标记进球";
    const label = document.createElement("span");
    label.textContent = card.label;
    const number = document.createElement("small");
    number.textContent = `台球 ${card.number} 号`;
    element.append(label);
    if (card.extra_draw) {
        const drawMarker = document.createElement("span");
        drawMarker.className = "drawn-card-marker";
        drawMarker.textContent = "抽";
        drawMarker.setAttribute("aria-hidden", "true");
        element.append(drawMarker);
    }
    element.append(number);
    if (canToggle) {
        element.addEventListener("click", () => togglePocketed(card.number, element));
    }
    container.append(element);
}

function renderMembers(room) {
    const memberList = document.getElementById("roomMembers");
    if (
        document.activeElement?.classList.contains("member-score-input")
        || memberList.querySelector(".member-score-controls:hover")
    ) {
        return;
    }
    const pottedNumbers = new Set(room.potted_numbers);
    memberList.replaceChildren();
    for (const member of room.players) {
        const item = document.createElement("li");
        item.className = "room-member";
        const info = document.createElement("div");
        info.className = "member-info";
        const name = document.createElement("span");
        name.className = "member-name";
        name.textContent = member.username === room.host_username
            ? `${member.username}（房主）`
            : member.username;
        const memberHeading = document.createElement("div");
        memberHeading.className = "member-heading";
        memberHeading.append(name);
        if (member.role === "player") {
            if (room.status === "playing") {
                const remainingCards = document.createElement("span");
                remainingCards.className = "member-unpotted-count";
                remainingCards.textContent = `未进球 ${member.unpotted_card_count} 张`;
                memberHeading.append(remainingCards);
            }
            const scoreLabel = document.createElement("label");
            scoreLabel.className = "member-score";
            const scoreCaption = document.createElement("span");
            scoreCaption.textContent = "分数（支持正负）";
            const scoreInput = document.createElement("input");
            scoreInput.className = "member-score-input";
            scoreInput.type = "number";
            scoreInput.step = "1";
            scoreInput.min = "-1000000000";
            scoreInput.max = "1000000000";
            scoreInput.value = scoreDrafts.get(member.username) ?? String(member.score);
            const canEditScore = room.role === "referee"
                || (member.active && member.username === currentUsername);
            scoreInput.disabled = !canEditScore;
            scoreInput.setAttribute("aria-label", `${member.username}的分数`);
            const scoreControls = document.createElement("div");
            scoreControls.className = "member-score-controls";
            const confirmButton = document.createElement("button");
            confirmButton.className = "secondary member-score-confirm";
            confirmButton.type = "button";
            confirmButton.textContent = "确认分数";
            confirmButton.disabled = !canEditScore
                || scoreInput.value === String(member.score);
            scoreInput.addEventListener("input", () => {
                if (scoreInput.value === String(member.score)) {
                    scoreDrafts.delete(member.username);
                } else {
                    scoreDrafts.set(member.username, scoreInput.value);
                }
                confirmButton.disabled = !canEditScore
                    || scoreInput.value === String(member.score);
            });
            confirmButton.addEventListener("click", () => {
                updateMemberScore(member.username, scoreInput, confirmButton);
            });
            scoreLabel.append(scoreCaption, scoreInput);
            scoreControls.append(scoreLabel, confirmButton);
            memberHeading.append(scoreControls);
        }
        const badge = document.createElement("span");
        badge.className = "member-badge";
        if (!member.active) {
            badge.textContent = "已离开";
            badge.classList.add("member-waiting");
        } else if (member.role === "referee") {
            badge.textContent = "裁判";
        } else if (room.status === "playing") {
            badge.textContent = "对局中";
            badge.classList.add("member-ready");
        } else {
            badge.textContent = member.ready ? "已准备" : "等待准备";
            badge.classList.add(member.ready ? "member-ready" : "member-waiting");
        }
        info.append(memberHeading, badge);
        item.append(info);

        if (room.role === "referee" && member.role === "player" && room.status === "playing") {
            const cards = document.createElement("div");
            cards.className = "member-card-groups";
            if (member.cards.length) {
                appendCardGroup(cards, "未进球", member.cards.filter(
                    (card) => !pottedNumbers.has(card.number)
                ), pottedNumbers, true);
                appendCardGroup(cards, "已进球", member.cards.filter(
                    (card) => pottedNumbers.has(card.number)
                ), pottedNumbers, true);
            } else {
                const waiting = document.createElement("span");
                waiting.className = "member-badge";
                waiting.textContent = "尚未抽牌";
                cards.append(waiting);
            }
            item.append(cards);
        }
        memberList.append(item);
    }
}

async function updateMemberScore(username, input, confirmButton) {
    const score = input.valueAsNumber;
    if (!Number.isInteger(score) || score < -1_000_000_000 || score > 1_000_000_000) {
        roomStatus.textContent = "分数必须是 -1,000,000,000 到 1,000,000,000 之间的整数。";
        return;
    }
    input.readOnly = true;
    confirmButton.disabled = true;
    let saved = false;
    try {
        const room = await request("/api/billiards/score", {
            method: "POST",
            body: JSON.stringify({ username, score })
        });
        scoreDrafts.delete(username);
        saved = true;
        renderRoom(room);
        input.value = String(score);
    } catch (error) {
        roomStatus.textContent = error.message;
    } finally {
        if (input.isConnected) input.readOnly = false;
        if (confirmButton.isConnected) confirmButton.disabled = saved;
    }
}

function appendCardGroup(container, title, cards, pottedNumbers, canToggle) {
    const group = document.createElement("section");
    group.className = `card-group${title === "已进球" ? " pocketed-group" : ""}`;
    const heading = document.createElement("h3");
    heading.className = "card-group-heading";
    heading.textContent = `${title}（${cards.length}）`;
    const cardList = document.createElement("div");
    cardList.className = "member-cards";
    [...cards]
        .sort((first, second) => first.number - second.number || first.label.localeCompare(second.label))
        .forEach((card) => appendCard(cardList, card, pottedNumbers, canToggle));
    group.append(heading, cardList);
    container.append(group);
}

function renderOwnCards(cards, pottedNumbers) {
    const drawForm = document.getElementById("drawForm");
    const myCards = document.getElementById("myCards");
    if (!cards.length) {
        drawForm.classList.remove("hidden");
        myCards.classList.add("hidden");
        document.getElementById("drawMoreButton").classList.add("hidden");
        return;
    }
    drawForm.classList.add("hidden");
    myCards.classList.remove("hidden");
    myCards.replaceChildren();
    const pottedSet = new Set(pottedNumbers);
    appendCardGroup(myCards, "未进球", cards.filter(
        (card) => !pottedSet.has(card.number)
    ), pottedSet, true);
    appendCardGroup(myCards, "已进球", cards.filter(
        (card) => pottedSet.has(card.number)
    ), pottedSet, true);
    document.getElementById("drawMoreButton").classList.remove("hidden");
}

function renderRoom(room) {
    currentRoom = room;
    roomActions.classList.add("hidden");
    roomPanel.classList.remove("hidden");
    document.getElementById("backToGames").classList.add("hidden");
    document.getElementById("roomCode").textContent = room.room_code;
    const allPlayersDrawn = room.player_count > 0
        && room.drawn_count === room.player_count;
    document.getElementById("roomPhase").textContent = room.status !== "playing"
        ? "等待玩家"
        : allPlayersDrawn
            ? "抽牌已完成"
            : "抽牌进行中";
    document.getElementById("roomMemberCount").textContent =
        `${room.player_count} / ${room.capacity} 位玩家`;
    document.getElementById("roomSummary").textContent =
        `房主：${room.host_username}　·　已准备：${room.ready_count} / ${room.player_count}`;
    const pocketedCount = room.potted_numbers.length;
    document.getElementById("roomSummary").textContent +=
        `　·　已进球号码：${pocketedCount ? room.potted_numbers.join("、") : "无"}`;
    document.getElementById("billiardsHeading").innerHTML =
        room.status === "playing" ? "抽牌决定<span>台球号码</span>" : "房间已创建，<span>等待好友加入</span>";
    document.getElementById("billiardsDescription").textContent =
        room.role === "referee"
            ? "你已作为裁判加入，可以查看所有玩家的抽牌结果。"
            : room.status === "playing"
                ? "选择抽牌数量，抽取的扑克牌不会与其他玩家重复。"
                : "将房间号分享给好友，所有玩家准备就绪后由房主开始游戏。";
    renderMembers(room);

    const ownPlayer = room.players.find(
        (member) => member.username === currentUsername && member.role === "player"
    );
    const readyButton = document.getElementById("readyButton");
    const startButton = document.getElementById("startButton");
    readyButton.classList.toggle(
        "hidden", room.status !== "lobby" || room.role !== "player"
    );
    if (ownPlayer) {
        readyButton.textContent = ownPlayer.ready ? "取消准备" : "我已准备";
    }
    const allReady = room.player_count === room.capacity
        && room.ready_count === room.player_count;
    startButton.classList.toggle("hidden", room.status !== "lobby" || !room.is_host);
    startButton.disabled = !allReady;
    startButton.textContent = allReady ? "所有人已准备，开始游戏" : "等待所有玩家准备";

    document.getElementById("restartButton").classList.toggle(
        "hidden", room.status !== "playing" || !room.is_host
    );

    const drawPanel = document.getElementById("drawPanel");
    const mayDraw = room.status === "playing" && room.role === "player";
    drawPanel.classList.toggle("hidden", !mayDraw);
    if (mayDraw) {
        renderOwnCards(ownPlayer?.cards ?? [], room.potted_numbers);
    }
    document.getElementById("drawCount").max = String(Math.min(15, Math.max(1, 54)));
    roomStatus.textContent = room.status === "lobby"
        ? (room.player_count < room.capacity
            ? `等待好友加入：当前 ${room.player_count} / ${room.capacity} 人。`
            : "所有玩家已加入，请点击“我已准备”，房主即可开始游戏。")
        : room.role === "referee"
            ? "裁判视图：玩家抽牌后，结果会自动显示在房间成员列表中。"
            : ownPlayer && ownPlayer.cards.length
                ? (room.drawn_count === room.player_count
                    ? "抽牌完成，开始对局。"
                    : "抽牌完成，等待其他玩家抽牌。")
                : "游戏已开始，选择数量后抽牌。";
    roomStatus.classList.remove("success");
    if (room.status === "playing") roomStatus.classList.add("success");
    if (roomPollTimer === null) {
        roomPollTimer = window.setInterval(refreshRoom, ROOM_POLL_INTERVAL_MS);
    }
}

async function refreshRoom() {
    if (document.hidden || !currentRoom || roomRefreshInFlight) return;
    roomRefreshInFlight = true;
    try {
        const result = await request("/api/rooms/current");
        if (!result.room) {
            showBilliardsMenu();
            roomActionStatus.textContent = "房间已关闭或你已离开房间。";
            return;
        }

        renderRoom(result.room);
    } catch (error) {
        roomStatus.textContent = error.message;
        roomStatus.classList.remove("success");
    } finally {
        roomRefreshInFlight = false;
    }
}

async function togglePocketed(number, cardButton) {
    cardButton.disabled = true;
    roomStatus.textContent = "正在同步进球状态…";
    try {
        renderRoom(await request("/api/billiards/toggle-pocketed", {
            method: "POST",
            body: JSON.stringify({ number })
        }));
    } catch (error) {
        roomStatus.textContent = error.message;
    } finally {
        cardButton.disabled = false;
    }
}

async function enterRoom(room) {
    authView.classList.add("hidden");
    gamesView.classList.add("hidden");
    billiardsView.classList.remove("hidden");
    currentUser.textContent = currentUsername;
    userBar.classList.remove("hidden");
    renderRoom(room);
}

async function openSignedInHome() {
    try {
        const result = await request("/api/rooms/current");
        if (result.room) {
            await enterRoom(result.room);
        } else {
            showGames();
        }
    } catch (error) {
        showGames();
        gameStatus.textContent = error.message;
    }
}

async function submitRoomAction(form, path, getPayload) {
    const button = form.querySelector("button[type='submit']");
    button.disabled = true;
    roomActionStatus.classList.remove("success");
    roomActionStatus.textContent = "正在连接房间…";
    try {
        const room = await request(path, {
            method: "POST",
            body: JSON.stringify(getPayload())
        });
        roomActionStatus.textContent = "";
        await enterRoom(room);
    } catch (error) {
        roomActionStatus.textContent = error.message;
    } finally {
        button.disabled = false;
    }
}

document.getElementById("adminLoginLink").addEventListener("click", showAdminLogin);
document.getElementById("backToUserLogin").addEventListener("click", showUserLogin);

authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = authForm.querySelector("button[type='submit']");
    button.disabled = true;
    authStatus.classList.remove("success");
    authStatus.textContent = "正在处理…";
    const data = {
        username: document.getElementById("username").value.trim(),
        password: passwordInput.value
    };
    try {
        const result = await request("/api/login", {
            method: "POST",
            body: JSON.stringify(data)
        });
        currentUsername = result.username;
        await openSignedInHome();
    } catch (error) {
        authStatus.textContent = error.message;
    } finally {
        button.disabled = false;
    }
});

adminLoginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = adminLoginForm.querySelector("button[type='submit']");
    button.disabled = true;
    adminLoginStatus.textContent = "正在验证管理员身份…";
    const credentials = {
        username: document.getElementById("adminUsername").value.trim(),
        password: document.getElementById("adminPassword").value
    };
    try {
        const result = await request("/api/admin/login", {
            method: "POST",
            body: JSON.stringify(credentials)
        });
        showAdminConsole(result.username);
        adminLoginForm.reset();
    } catch (error) {
        adminLoginStatus.textContent = error.message;
    } finally {
        button.disabled = false;
    }
});

createAccountForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = createAccountForm.querySelector("button[type='submit']");
    button.disabled = true;
    createAccountStatus.textContent = "正在创建账号…";
    const account = {
        username: document.getElementById("newUsername").value.trim(),
        password: document.getElementById("newPassword").value
    };
    try {
        const result = await request("/api/admin/accounts", {
            method: "POST",
            body: JSON.stringify(account)
        });
        createAccountStatus.textContent = `账号 ${result.username} 已创建。`;
        createAccountStatus.classList.add("success");
        createAccountForm.reset();
    } catch (error) {
        createAccountStatus.textContent = error.message;
        createAccountStatus.classList.remove("success");
    } finally {
        button.disabled = false;
    }
});

document.getElementById("logoutButton").addEventListener("click", async () => {
    try {
        await request("/api/logout", { method: "POST", body: "{}" });
        stopRoomPolling();
        currentRoom = null;
        scoreDrafts.clear();
        gamesView.classList.add("hidden");
        billiardsView.classList.add("hidden");
        userBar.classList.add("hidden");
        authView.classList.remove("hidden");
        authForm.reset();
        adminLoginForm.reset();
        createAccountForm.reset();
        showUserLogin();
    } catch (error) {
        roomStatus.textContent = error.message;
    }
});

document.getElementById("billiardsCard").addEventListener("click", showBilliardsMenu);
document.getElementById("mahjongCard").addEventListener("click", () => {
    gameStatus.textContent = "麻将房间功能即将开放。";
    gameStatus.classList.add("success");
});
document.getElementById("backToGames").addEventListener("click", () => showGames());

document.getElementById("createRoomForm").addEventListener("submit", (event) => {
    event.preventDefault();
    submitRoomAction(event.currentTarget, "/api/billiards/rooms", () => ({
        capacity: Number(document.getElementById("roomCapacity").value)
    }));
});
document.getElementById("joinRoomForm").addEventListener("submit", (event) => {
    event.preventDefault();
    submitRoomAction(event.currentTarget, "/api/billiards/join", () => ({
        room_code: document.getElementById("joinRoomCode").value.trim()
    }));
});
document.getElementById("refereeForm").addEventListener("submit", (event) => {
    event.preventDefault();
    submitRoomAction(event.currentTarget, "/api/billiards/referee", () => ({
        room_code: document.getElementById("refereeRoomCode").value.trim()
    }));
});

document.getElementById("readyButton").addEventListener("click", async () => {
    if (!currentRoom) return;
    const ownPlayer = currentRoom.players.find(
        (member) => member.username === currentUsername && member.role === "player"
    );
    try {
        renderRoom(await request("/api/billiards/ready", {
            method: "POST",
            body: JSON.stringify({ ready: !ownPlayer.ready })
        }));
    } catch (error) {
        roomStatus.textContent = error.message;
    }
});
document.getElementById("roomMembers").addEventListener("focusout", (event) => {
    if (event.target.classList.contains("member-score-input")) {
        window.setTimeout(refreshRoom, 100);
    }
});
document.getElementById("startButton").addEventListener("click", async () => {
    try {
        renderRoom(await request("/api/billiards/start", { method: "POST", body: "{}" }));
    } catch (error) {
        roomStatus.textContent = error.message;
    }
});
document.getElementById("restartButton").addEventListener("click", async (event) => {
    if (!window.confirm("重新开局会清空所有玩家的手牌和进球状态，确定继续吗？")) {
        return;
    }
    const button = event.currentTarget;
    button.disabled = true;
    try {
        renderRoom(await request("/api/billiards/restart", {
            method: "POST",
            body: "{}"
        }));
    } catch (error) {
        roomStatus.textContent = error.message;
    } finally {
        button.disabled = false;
    }
});
document.getElementById("leaveButton").addEventListener("click", async () => {
    try {
        await request("/api/billiards/leave", { method: "POST", body: "{}" });
        showGames();
    } catch (error) {
        roomStatus.textContent = error.message;
    }
});
document.getElementById("drawForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = document.getElementById("drawButton");
    button.disabled = true;
    try {
        renderRoom(await request("/api/billiards/draw", {
            method: "POST",
            body: JSON.stringify({ count: Number(document.getElementById("drawCount").value) })
        }));
    } catch (error) {
        roomStatus.textContent = error.message;
    } finally {
        button.disabled = false;
    }
});
document.getElementById("drawMoreButton").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    roomStatus.textContent = "正在从剩余牌库抽牌…";
    try {
        renderRoom(await request("/api/billiards/draw-one-more", {
            method: "POST",
            body: "{}"
        }));
    } catch (error) {
        roomStatus.textContent = error.message;
    } finally {
        button.disabled = false;
    }
});
document.getElementById("copyRoomCode").addEventListener("click", async () => {
    if (!currentRoom) return;
    try {
        await navigator.clipboard.writeText(currentRoom.room_code);
        roomStatus.textContent = "房间号已复制，可以分享给好友。";
        roomStatus.classList.add("success");
    } catch (error) {
        roomStatus.textContent = `复制失败，请手动复制房间号：${currentRoom.room_code}`;
        roomStatus.classList.remove("success");
    }
});

request("/api/me")
    .then((result) => {
        if (result.role === "admin") {
            showAdminConsole(result.username);
            return;
        }
        currentUsername = result.username;
        userBar.classList.remove("hidden");
        currentUser.textContent = currentUsername;
        return openSignedInHome();
    })
    .catch(() => {
        authView.classList.remove("hidden");
        gamesView.classList.add("hidden");
        billiardsView.classList.add("hidden");
        showUserLogin();
    });
