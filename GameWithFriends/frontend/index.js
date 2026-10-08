const authView = document.getElementById("authView");
const gamesView = document.getElementById("gamesView");
const billiardsView = document.getElementById("billiardsView");
const userBar = document.getElementById("userBar");
const currentUser = document.getElementById("currentUser");
const nicknameButton = document.getElementById("nicknameButton");
const nicknameForm = document.getElementById("nicknameForm");
const nicknameInput = document.getElementById("nicknameInput");
const nicknameStatus = document.getElementById("nicknameStatus");
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
const adminAccountList = document.getElementById("adminAccountList");
const accountListStatus = document.getElementById("accountListStatus");
const roomActions = document.getElementById("roomActions");
const roomDirectory = document.getElementById("roomDirectory");
const roomDirectoryStatus = document.getElementById("roomDirectoryStatus");
const roomDirectoryList = document.getElementById("roomDirectoryList");
const roomPanel = document.getElementById("roomPanel");
let roomPollTimer = null;
let roomRefreshInFlight = false;
let roleSwitchInFlight = false;
let roomDirectoryPollTimer = null;
let roomDirectoryRefreshInFlight = false;
let currentRoom = null;
let currentUsername = "";
let currentNickname = "";
const scoreDrafts = new Map();
const scoreDraftVersions = new Map();
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

function showAdminConsole(username, nickname = username) {
    currentUsername = username;
    currentNickname = nickname;
    currentUser.textContent = currentNickname;
    nicknameButton.classList.add("hidden");
    nicknameForm.classList.add("hidden");
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
    loadAdminAccounts();
}

async function loadAdminAccounts() {
    accountListStatus.textContent = "正在加载用户列表…";
    accountListStatus.classList.remove("success");
    try {
        const result = await request("/api/admin/accounts");
        adminAccountList.replaceChildren();
        if (!result.accounts.length) {
            const emptyMessage = document.createElement("li");
            emptyMessage.className = "admin-account-list-empty";
            emptyMessage.textContent = "暂无用户账号。";
            adminAccountList.append(emptyMessage);
        }
        for (const account of result.accounts) {
            const item = document.createElement("li");
            item.className = "admin-account-item";
            const details = document.createElement("div");
            details.className = "admin-account-details";
            const accountName = document.createElement("strong");
            accountName.textContent = account.nickname || account.username;
            const metadata = document.createElement("span");
            metadata.textContent =
                `账号：${account.username} · 创建于 ${new Date(account.created_at * 1000).toLocaleString()}`;
            details.append(accountName, metadata);
            const deleteButton = document.createElement("button");
            deleteButton.className = "secondary admin-account-delete";
            deleteButton.type = "button";
            deleteButton.textContent = "删除";
            deleteButton.addEventListener("click", () => deleteAdminAccount(account.username));
            item.append(details, deleteButton);
            adminAccountList.append(item);
        }
        accountListStatus.textContent = `共 ${result.accounts.length} 个用户账号。`;
        accountListStatus.classList.add("success");
    } catch (error) {
        accountListStatus.textContent = error.message;
    }
}

async function deleteAdminAccount(username) {
    if (!window.confirm(
        `确定删除账号 ${username} 吗？该账号关联开放房间时无法删除；历史对局保留，但用户身份会匿名化。`
    )) {
        return;
    }
    accountListStatus.textContent = `正在删除账号 ${username}…`;
    accountListStatus.classList.remove("success");
    try {
        await request("/api/admin/accounts/delete", {
            method: "POST",
            body: JSON.stringify({ username })
        });
        await loadAdminAccounts();
        accountListStatus.textContent = `账号 ${username} 已删除。`;
        accountListStatus.classList.add("success");
    } catch (error) {
        accountListStatus.textContent = error.message;
    }
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
        error.result = result;
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

function stopRoomDirectoryPolling() {
    if (roomDirectoryPollTimer !== null) {
        window.clearInterval(roomDirectoryPollTimer);
        roomDirectoryPollTimer = null;
    }
}

function showGames(username = currentUsername) {
    stopRoomPolling();
    stopRoomDirectoryPolling();
    currentRoom = null;
    scoreDrafts.clear();
    scoreDraftVersions.clear();
    currentUsername = username;
    currentUser.textContent = currentNickname;
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
    scoreDraftVersions.clear();
    gamesView.classList.add("hidden");
    billiardsView.classList.remove("hidden");
    roomActions.classList.remove("hidden");
    roomDirectory.classList.remove("hidden");
    roomPanel.classList.add("hidden");
    document.getElementById("backToGames").classList.remove("hidden");
    document.getElementById("billiardsHeading").innerHTML = "来一场<span>台球对决</span>";
    document.getElementById("billiardsDescription").textContent =
        "创建房间，或从下方未关闭的房间列表中直接加入好友的游戏。";
    roomActionStatus.textContent = "";
    refreshRoomDirectory();
    if (roomDirectoryPollTimer === null) {
        roomDirectoryPollTimer = window.setInterval(refreshRoomDirectory, 1000);
    }
}

async function refreshRoomDirectory() {
    if (document.hidden || currentRoom || roomDirectoryRefreshInFlight) return;
    roomDirectoryRefreshInFlight = true;
    try {
        const result = await request("/api/billiards/rooms");
        roomDirectoryList.replaceChildren();
        if (!result.rooms.length) {
            const emptyMessage = document.createElement("li");
            emptyMessage.className = "room-directory-empty";
            emptyMessage.textContent = "目前没有未关闭的房间。创建房间后，好友会在这里看到。";
            roomDirectoryList.append(emptyMessage);
        }
        for (const room of result.rooms) {
            const item = document.createElement("li");
            item.className = "room-directory-item";
            const info = document.createElement("div");
            info.className = "room-directory-info";
            const code = document.createElement("div");
            code.className = "room-directory-code";
            code.textContent = room.room_code;
            const status = document.createElement("span");
            status.className = `room-directory-phase ${room.status}`;
            status.textContent = room.status === "lobby" ? "等待中" : "游戏中";
            const meta = document.createElement("div");
            meta.className = "room-directory-meta";
            const host = document.createElement("span");
            host.textContent = `房主：${room.host_nickname}`;
            const players = document.createElement("span");
            players.textContent = `玩家 ${room.player_count} · 裁判 ${room.referee_count}`;
            meta.append(host, players);
            const button = document.createElement("button");
            const mayJoin = room.status === "lobby";
            const canReturn = Boolean(room.my_role);
            const mayEnter = mayJoin || canReturn;
            button.className = mayJoin && !canReturn ? "primary" : "secondary";
            button.type = "button";
            button.disabled = !mayEnter;
            button.textContent = room.status !== "lobby"
                ? canReturn ? "按原身份返回" : "游戏中"
                : canReturn
                    ? "重新进入房间"
                    : "加入房间";
            button.addEventListener("click", () => joinListedRoom(room, button));
            info.append(code, status, meta);
            item.append(info, button);
            roomDirectoryList.append(item);
        }
        roomDirectoryStatus.textContent = `共 ${result.rooms.length} 个未关闭房间。`;
        roomDirectoryStatus.classList.remove("success");
    } catch (error) {
        roomDirectoryStatus.textContent = error.message;
        roomDirectoryStatus.classList.remove("success");
    } finally {
        roomDirectoryRefreshInFlight = false;
    }
}

async function joinListedRoom(room, button) {
    button.disabled = true;
    roomActionStatus.classList.remove("success");
    roomActionStatus.textContent = "正在连接房间…";
    try {
        const snapshot = await request("/api/billiards/join", {
            method: "POST",
            body: JSON.stringify({ room_code: room.room_code })
        });
        roomActionStatus.textContent = "";
        await enterRoom(snapshot);
    } catch (error) {
        roomActionStatus.textContent = error.message;
        await refreshRoomDirectory();
    } finally {
        button.disabled = false;
    }
}

function appendCard(container, card, pottedNumbers, canToggle) {
    const element = document.createElement("button");
    const isPocketed = pottedNumbers.has(card.number);
    element.type = "button";
    element.className = `playing-card${/[♥♦]/u.test(card.label) ? " red-card" : ""}${isPocketed ? " pocketed" : ""}`;
    element.dataset.cardLabel = card.label;
    element.dataset.cardNumber = String(card.number);
    element.dataset.pocketed = String(isPocketed);
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
    if (isPocketed) {
        const pocketedMarker = document.createElement("span");
        pocketedMarker.className = "pocketed-card-marker";
        pocketedMarker.textContent = "已进球";
        element.append(pocketedMarker);
    }
    if (canToggle) {
        element.addEventListener("click", () => {
            setPocketed(card.number, element.dataset.pocketed !== "true", element);
        });
    }
    container.append(element);
}

function updateRenderedCardStates(container, pottedNumbers) {
    const pottedSet = new Set(pottedNumbers);
    for (const element of container.querySelectorAll(".playing-card")) {
        const number = Number(element.dataset.cardNumber);
        const label = element.dataset.cardLabel;
        const isPocketed = pottedSet.has(number);
        element.dataset.pocketed = String(isPocketed);
        element.classList.toggle("pocketed", isPocketed);
        let pocketedMarker = element.querySelector(".pocketed-card-marker");
        if (isPocketed && !pocketedMarker) {
            pocketedMarker = document.createElement("span");
            pocketedMarker.className = "pocketed-card-marker";
            pocketedMarker.textContent = "已进球";
            element.append(pocketedMarker);
        } else if (!isPocketed) {
            pocketedMarker?.remove();
        }
        element.setAttribute(
            "aria-label",
            `${label}，台球 ${number} 号，${isPocketed ? "已进球，点击可撤销" : "未进球，点击标记进球"}`
        );
        element.title = isPocketed ? "已进球，点击撤销" : "未进球，点击标记进球";
    }
}

function createMemberElement(room, member, pottedNumbers) {
    const item = document.createElement("li");
    item.className = "room-member";
    item.dataset.username = member.username;
    const info = document.createElement("div");
    info.className = "member-info";
    const name = document.createElement("span");
    name.className = "member-name";
    const nickname = member.nickname;
    name.textContent = member.username === room.host_username
        ? `${nickname}（房主）`
        : nickname;
    const memberHeading = document.createElement("div");
    memberHeading.className = "member-heading";
    memberHeading.append(name);
    let scoreControls = null;
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
        scoreInput.dataset.username = member.username;
        scoreInput.dataset.confirmedScore = String(member.score);
        scoreInput.dataset.scoreVersion = String(member.score_version);
        scoreInput.dataset.editVersion = scoreDraftVersions.get(member.username)
            ?? String(member.score_version);
        const canEditScore = room.role === "referee"
            || (member.active && member.username === currentUsername);
        scoreInput.disabled = !canEditScore;
        scoreInput.setAttribute("aria-label", `${nickname}的分数`);
        scoreInput.addEventListener("focus", () => {
            if (!scoreDrafts.has(member.username)) {
                scoreInput.dataset.editVersion = scoreInput.dataset.scoreVersion;
            }
        });
        scoreControls = document.createElement("div");
        scoreControls.className = "member-score-controls";
        const confirmButton = document.createElement("button");
        confirmButton.className = "secondary member-score-confirm";
        confirmButton.type = "button";
        confirmButton.textContent = "确认分数";
        confirmButton.disabled = !canEditScore
            || scoreInput.value === scoreInput.dataset.confirmedScore;
        scoreInput.addEventListener("input", () => {
            if (scoreInput.value === scoreInput.dataset.confirmedScore) {
                scoreDrafts.delete(member.username);
                scoreDraftVersions.delete(member.username);
            } else {
                if (!scoreDrafts.has(member.username)) {
                    scoreDraftVersions.set(member.username, scoreInput.dataset.editVersion);
                }
                scoreDrafts.set(member.username, scoreInput.value);
            }
            confirmButton.disabled = !canEditScore
                || scoreInput.value === scoreInput.dataset.confirmedScore;
        });
        confirmButton.addEventListener("click", () => {
            updateMemberScore(member.username, scoreInput, confirmButton);
        });
        scoreLabel.append(scoreCaption, scoreInput);
        scoreControls.append(scoreLabel, confirmButton);
    }
    const badge = document.createElement("span");
    updateMemberBadge(badge, room, member);
    info.append(memberHeading);
    if (scoreControls) info.append(scoreControls);
    info.append(badge);
    item.append(info);

    if (room.role === "referee" && member.role === "player" && room.status === "playing") {
        const cards = document.createElement("div");
        cards.className = "member-card-groups";
        if (member.cards.length) {
            appendCardGroup(cards, "手牌", member.cards, pottedNumbers, true);
        } else {
            const waiting = document.createElement("span");
            waiting.className = "member-badge";
            waiting.textContent = "尚未抽牌";
            cards.append(waiting);
        }
        item.append(cards);
    }
    return item;
}

function updateMemberBadge(badge, room, member) {
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
}

function renderMembers(room, forceCardRender = false) {
    const memberList = document.getElementById("roomMembers");
    const focusedInput = document.activeElement?.classList.contains("member-score-input")
        ? document.activeElement
        : null;
    const hoveredItem = !forceCardRender
        ? memberList.querySelector(".member-score-controls:hover, .playing-card:hover")
            ?.closest(".room-member")
        : null;
    const preservedItem = focusedInput?.closest(".room-member") ?? hoveredItem;
    if (preservedItem && !forceCardRender) {
        updateRenderedCardStates(memberList, room.potted_numbers);
        const pottedNumbers = new Set(room.potted_numbers);
        const membersByUsername = new Map(room.players.map(
            (member) => [member.username, member]
        ));
        const renderedUsernames = new Set();
        for (const item of Array.from(memberList.children)) {
            const username = item.dataset.username;
            const member = membersByUsername.get(username);
            if (!member) {
                item.remove();
                continue;
            }
            renderedUsernames.add(username);
            if (item === preservedItem) {
                const nickname = member.nickname;
                const name = item.querySelector(".member-name");
                if (name) {
                    name.textContent = member.username === room.host_username
                        ? `${nickname}（房主）`
                        : nickname;
                }
                const badge = item.querySelector(".member-info > .member-badge");
                if (badge) updateMemberBadge(badge, room, member);
                const input = item.querySelector(".member-score-input");
                if (input) {
                    input.dataset.confirmedScore = String(member.score);
                    input.dataset.scoreVersion = String(member.score_version);
                    if (document.activeElement !== input && !scoreDrafts.has(username)) {
                        input.value = String(member.score);
                        input.dataset.editVersion = String(member.score_version);
                    }
                    const confirmButton = item.querySelector(".member-score-confirm");
                    if (confirmButton) {
                        confirmButton.disabled = input.disabled
                            || input.value === input.dataset.confirmedScore;
                    }
                }
                continue;
            }
            item.replaceWith(createMemberElement(room, member, pottedNumbers));
        }
        for (const member of room.players) {
            if (!renderedUsernames.has(member.username)) {
                memberList.append(createMemberElement(room, member, pottedNumbers));
            }
        }
        return;
    }
    const pottedNumbers = new Set(room.potted_numbers);
    memberList.replaceChildren(
        ...room.players.map((member) => createMemberElement(room, member, pottedNumbers))
    );
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
            body: JSON.stringify({
                username,
                score,
                score_version: Number(input.dataset.editVersion)
            })
        });
        scoreDrafts.delete(username);
        scoreDraftVersions.delete(username);
        saved = true;
        renderRoom(room);
        input.value = String(score);
        input.dataset.confirmedScore = String(score);
        const updatedMember = room.players.find((member) => member.username === username);
        if (updatedMember) {
            input.dataset.scoreVersion = String(updatedMember.score_version);
            input.dataset.editVersion = String(updatedMember.score_version);
        }
    } catch (error) {
        if (error.status === 409 && error.result?.room) {
            scoreDrafts.delete(username);
            scoreDraftVersions.delete(username);
            renderRoom(error.result.room);
            const latestMember = error.result.room.players.find(
                (member) => member.username === username
            );
            const latestInput = Array.from(
                document.querySelectorAll(".member-score-input")
            ).find((scoreInput) => scoreInput.dataset.username === username);
            if (latestMember && latestInput) {
                latestInput.value = String(latestMember.score);
                latestInput.dataset.confirmedScore = String(latestMember.score);
                latestInput.dataset.scoreVersion = String(latestMember.score_version);
                latestInput.dataset.editVersion = String(latestMember.score_version);
            }
        }
        roomStatus.textContent = error.message;
    } finally {
        if (input.isConnected) input.readOnly = false;
        if (confirmButton.isConnected) confirmButton.disabled = saved;
    }
}

function appendCardGroup(container, title, cards, pottedNumbers, canToggle) {
    const group = document.createElement("section");
    group.className = "card-group";
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

function renderOwnCards(cards, pottedNumbers, forceCardRender = false) {
    const drawForm = document.getElementById("drawForm");
    const myCards = document.getElementById("myCards");
    if (!forceCardRender && myCards.querySelector(".playing-card:hover")) {
        updateRenderedCardStates(myCards, pottedNumbers);
        return;
    }
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
    appendCardGroup(myCards, "手牌", cards, pottedSet, true);
    document.getElementById("drawMoreButton").classList.remove("hidden");
}

function renderRoom(room, forceCardRender = false) {
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
        `${room.member_count} 位成员 · 玩家 ${room.player_count} · 裁判 ${room.referee_count}`;
    document.getElementById("roomSummary").textContent =
        `房主：${room.host_nickname}　·　已准备：${room.ready_count} / ${room.player_count}`;
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
    renderMembers(room, forceCardRender);

    const ownPlayer = room.players.find(
        (member) => member.username === currentUsername && member.role === "player"
    );
    const readyButton = document.getElementById("readyButton");
    const switchRoleButton = document.getElementById("switchRoleButton");
    const startButton = document.getElementById("startButton");
    readyButton.classList.toggle(
        "hidden", room.status !== "lobby" || room.role !== "player"
    );
    if (ownPlayer) {
        readyButton.textContent = ownPlayer.ready ? "取消准备" : "准备";
    }
    switchRoleButton.classList.toggle("hidden", room.status !== "lobby");
    const cannotBecomeReferee = room.role === "player" && room.player_count <= 1;
    switchRoleButton.disabled = roleSwitchInFlight
        || room.status !== "lobby"
        || cannotBecomeReferee;
    switchRoleButton.textContent = room.role === "player"
        ? "切换为裁判"
        : "切换为玩家";
    switchRoleButton.title = cannotBecomeReferee
        ? "房间至少需要两名玩家，才能切换为裁判"
        : "";
    const allReady = room.player_count >= 2
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
        renderOwnCards(ownPlayer?.cards ?? [], room.potted_numbers, forceCardRender);
    }
    document.getElementById("drawCount").max = String(Math.min(15, Math.max(1, 54)));
    roomStatus.textContent = room.status === "lobby"
        ? room.role === "referee"
            ? "等待中：你可以随时切换为玩家，房主开始游戏后可查看抽牌结果。"
            : room.player_count < 2
                ? "至少需要两名玩家才能开始游戏；仅剩一名玩家时不能切换为裁判。"
                : room.ready_count === room.player_count
                    ? "所有玩家已准备，房主可以开始游戏。"
                    : "等待所有玩家准备，房主即可开始游戏。"
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

async function setPocketed(number, pocketed, cardButton) {
    cardButton.disabled = true;
    roomStatus.textContent = "正在同步进球状态…";
    try {
        renderRoom(await request("/api/billiards/set-pocketed", {
            method: "POST",
            body: JSON.stringify({ number, pocketed })
        }), true);
    } catch (error) {
        roomStatus.textContent = error.message;
    } finally {
        cardButton.disabled = false;
    }
}

async function enterRoom(room) {
    stopRoomDirectoryPolling();
    authView.classList.add("hidden");
    gamesView.classList.add("hidden");
    billiardsView.classList.remove("hidden");
    roomDirectory.classList.add("hidden");
    currentUser.textContent = currentNickname;
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
        currentNickname = result.nickname;
        nicknameButton.classList.remove("hidden");
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
        showAdminConsole(result.username, result.nickname);
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
        await loadAdminAccounts();
    } catch (error) {
        createAccountStatus.textContent = error.message;
        createAccountStatus.classList.remove("success");
    } finally {
        button.disabled = false;
    }
});

document.getElementById("refreshAccounts").addEventListener("click", loadAdminAccounts);
document.getElementById("refreshRoomDirectory").addEventListener("click", refreshRoomDirectory);

document.getElementById("logoutButton").addEventListener("click", async () => {
    try {
        await request("/api/logout", { method: "POST", body: "{}" });
        stopRoomPolling();
        currentRoom = null;
        scoreDrafts.clear();
        scoreDraftVersions.clear();
        gamesView.classList.add("hidden");
        billiardsView.classList.add("hidden");
        userBar.classList.add("hidden");
        nicknameButton.classList.add("hidden");
        nicknameForm.classList.add("hidden");
        authView.classList.remove("hidden");
        authForm.reset();
        adminLoginForm.reset();
        createAccountForm.reset();
        showUserLogin();
    } catch (error) {
        roomStatus.textContent = error.message;
    }
});

document.getElementById("nicknameButton").addEventListener("click", () => {
    nicknameInput.value = currentNickname;
    nicknameStatus.textContent = "";
    nicknameStatus.classList.remove("success");
    nicknameForm.classList.remove("hidden");
    nicknameInput.focus();
});

document.getElementById("cancelNickname").addEventListener("click", () => {
    nicknameForm.classList.add("hidden");
    nicknameStatus.textContent = "";
});

nicknameForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = nicknameForm.querySelector("button[type='submit']");
    button.disabled = true;
    nicknameStatus.textContent = "正在保存昵称…";
    nicknameStatus.classList.remove("success");
    try {
        const result = await request("/api/profile/nickname", {
            method: "POST",
            body: JSON.stringify({ nickname: nicknameInput.value.trim() })
        });
        currentNickname = result.nickname;
        currentUser.textContent = currentNickname;
        if (currentRoom) {
            const ownMember = currentRoom.players.find(
                (member) => member.username === currentUsername
            );
            if (ownMember) ownMember.nickname = currentNickname;
            if (currentRoom.host_username === currentUsername) {
                currentRoom.host_nickname = currentNickname;
            }
            renderRoom(currentRoom, true);
        }
        nicknameStatus.textContent = "昵称已更新。";
        nicknameStatus.classList.add("success");
        nicknameForm.classList.add("hidden");
    } catch (error) {
        nicknameStatus.textContent = error.message;
    } finally {
        button.disabled = false;
    }
});

document.getElementById("billiardsCard").addEventListener("click", showBilliardsMenu);
document.getElementById("backToGames").addEventListener("click", () => showGames());

document.getElementById("createRoomForm").addEventListener("submit", (event) => {
    event.preventDefault();
    submitRoomAction(event.currentTarget, "/api/billiards/rooms", () => ({}));
});
document.getElementById("joinRoomForm").addEventListener("submit", (event) => {
    event.preventDefault();
    submitRoomAction(event.currentTarget, "/api/billiards/join", () => ({
        room_code: document.getElementById("joinRoomCode").value.trim()
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
document.getElementById("switchRoleButton").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (roleSwitchInFlight || !currentRoom || currentRoom.status !== "lobby") return;
    roleSwitchInFlight = true;
    button.disabled = true;
    try {
        const role = currentRoom.role === "player" ? "referee" : "player";
        renderRoom(await request("/api/billiards/role", {
            method: "POST",
            body: JSON.stringify({ role })
        }));
    } catch (error) {
        roomStatus.textContent = error.message;
        roomStatus.classList.remove("success");
    } finally {
        roleSwitchInFlight = false;
        button.disabled = currentRoom?.status !== "lobby";
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
            showAdminConsole(result.username, result.nickname);
            return;
        }
        currentUsername = result.username;
        currentNickname = result.nickname;
        userBar.classList.remove("hidden");
        nicknameButton.classList.remove("hidden");
        currentUser.textContent = currentNickname;
        return openSignedInHome();
    })
    .catch(() => {
        authView.classList.remove("hidden");
        gamesView.classList.add("hidden");
        billiardsView.classList.add("hidden");
        showUserLogin();
    });
