// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

import { SongDocument } from "./SongDocument";
import { ChangeSong } from "./changes";

const multiplayerWorkerUrl: string = "https://abyssbox-pro-multiplayer.ahmaririley64.workers.dev";
const roomAlphabet: string = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const roomCodeLength: number = 6;
const syncDelayMs: number = 90;

interface MultiplayerUser {
    id: string;
    name: string;
}

interface WelcomeMessage {
    type: "welcome";
    room: string;
    song: string;
    revision: number;
    users: MultiplayerUser[];
}

interface StateMessage {
    type: "state";
    song: string;
    revision: number;
    clientId: string;
}

interface PresenceMessage {
    type: "presence";
    users: MultiplayerUser[];
}

interface ErrorMessage {
    type: "error";
    message: string;
}

type ServerMessage = WelcomeMessage | StateMessage | PresenceMessage | ErrorMessage;

function makeClientId(): string {
    const existing: string | null = localStorage.getItem("abyssbox-pro-multiplayer-id");
    if (existing != null && existing != "") return existing;

    const id: string =
        typeof crypto.randomUUID == "function"
            ? crypto.randomUUID()
            : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);

    localStorage.setItem("abyssbox-pro-multiplayer-id", id);
    return id;
}

function makeGuestName(): string {
    const existing: string | null = localStorage.getItem("abyssbox-pro-multiplayer-name");
    if (existing != null && existing.trim() != "") return existing.trim();

    const name: string = "Guest " + Math.floor(1000 + Math.random() * 9000);
    localStorage.setItem("abyssbox-pro-multiplayer-name", name);
    return name;
}

function makeRoomCode(): string {
    let result: string = "";

    for (let i: number = 0; i < roomCodeLength; i++) {
        result += roomAlphabet[(Math.random() * roomAlphabet.length) | 0];
    }

    return result;
}

function cleanRoomCode(value: string): string {
    return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20);
}

function websocketUrl(workerUrl: string, room: string): string {
    const url: URL = new URL(workerUrl);
    url.protocol = url.protocol == "https:" ? "wss:" : "ws:";
    url.pathname = url.pathname.replace(/\/+$/, "") + "/room/" + encodeURIComponent(room);
    url.search = "";
    url.hash = "";
    return url.toString();
}

function setRoomInUrl(room: string | null): void {
    const url: URL = new URL(window.location.href);

    if (room == null || room == "") {
        url.searchParams.delete("room");
    } else {
        url.searchParams.set("room", room);
    }

    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}

export class MultiplayerClient {
    private readonly _doc: SongDocument;
    private readonly _clientId: string = makeClientId();

    private _name: string = makeGuestName();
    private _socket: WebSocket | null = null;
    private _room: string = "";
    private _revision: number = 0;
    private _roomUsers: MultiplayerUser[] = [];
    private _lastSong: string = "";
    private _syncTimer: number | null = null;
    private _connected: boolean = false;
    private _applyingRemote: boolean = false;

    private readonly _button: HTMLButtonElement;
    private readonly _panel: HTMLDivElement;
    private readonly _status: HTMLDivElement;
    private readonly _roomInput: HTMLInputElement;
    private readonly _nameInput: HTMLInputElement;
    private readonly _users: HTMLDivElement;
    private readonly _createButton: HTMLButtonElement;
    private readonly _joinButton: HTMLButtonElement;
    private readonly _copyButton: HTMLButtonElement;
    private readonly _leaveButton: HTMLButtonElement;

    constructor(doc: SongDocument, editorRoot: HTMLElement) {
        this._doc = doc;

        const style: HTMLStyleElement = document.createElement("style");
        style.textContent = `
            .abyssboxMultiplayerButton {
                width: auto !important;
                min-width: 2.4em;
                padding-left: 0.55em !important;
                padding-right: 0.55em !important;
                margin-left: 3px;
                flex: 0 0 auto;
            }

            .abyssboxMultiplayerPanel {
                position: fixed;
                top: 52px;
                right: 18px;
                z-index: 10020;
                width: 270px;
                box-sizing: border-box;
                padding: 9px;
                border: 1px solid var(--ui-widget-background, #555);
                border-radius: 3px;
                background: var(--editor-background, #151515);
                color: var(--primary-text, white);
                box-shadow: 0 5px 18px rgba(0, 0, 0, 0.42);
                font-family: inherit;
            }

            .abyssboxMultiplayerPanel[hidden] {
                display: none !important;
            }

            .abyssboxMultiplayerTitle {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 7px;
                font-weight: bold;
            }

            .abyssboxMultiplayerStatus {
                margin-bottom: 7px;
                padding: 5px 6px;
                background: var(--ui-widget-background, #292929);
                color: var(--secondary-text, #aaa);
                font-size: 11px;
            }

            .abyssboxMultiplayerRow {
                display: grid;
                grid-template-columns: 60px minmax(0, 1fr);
                gap: 6px;
                align-items: center;
                margin: 5px 0;
                font-size: 11px;
            }

            .abyssboxMultiplayerRow input {
                min-width: 0;
                width: 100%;
                box-sizing: border-box;
            }

            .abyssboxMultiplayerActions {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 5px;
                margin-top: 7px;
            }

            .abyssboxMultiplayerActions button {
                min-width: 0;
                width: 100%;
            }

            .abyssboxMultiplayerUsers {
                margin-top: 8px;
                padding-top: 7px;
                border-top: 1px solid var(--ui-widget-background, #444);
                font-size: 10px;
                color: var(--secondary-text, #aaa);
            }

            .abyssboxMultiplayerUser {
                display: flex;
                align-items: center;
                gap: 5px;
                margin-top: 3px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .abyssboxMultiplayerDot {
                width: 5px;
                height: 5px;
                flex: 0 0 5px;
                border-radius: 50%;
                background: var(--link-accent, #a778ff);
            }
        `;
        document.head.appendChild(style);

        this._button = document.createElement("button");
        this._button.type = "button";
        this._button.className = "abyssboxMultiplayerButton";
        this._button.textContent = "MP";
        this._button.title = "Multiplayer";
        this._button.addEventListener("click", () => {
            this._panel.hidden = !this._panel.hidden;
        });

        this._panel = document.createElement("div");
        this._panel.className = "abyssboxMultiplayerPanel";
        this._panel.hidden = true;

        const title: HTMLDivElement = document.createElement("div");
        title.className = "abyssboxMultiplayerTitle";

        const titleText: HTMLSpanElement = document.createElement("span");
        titleText.textContent = "Multiplayer";

        const closeButton: HTMLButtonElement = document.createElement("button");
        closeButton.type = "button";
        closeButton.textContent = "×";
        closeButton.style.width = "28px";
        closeButton.addEventListener("click", () => {
            this._panel.hidden = true;
        });

        title.append(titleText, closeButton);

        this._status = document.createElement("div");
        this._status.className = "abyssboxMultiplayerStatus";
        this._status.textContent = "Not connected";

        this._roomInput = document.createElement("input");
        this._roomInput.type = "text";
        this._roomInput.maxLength = 20;
        this._roomInput.placeholder = "ABC123";

        this._nameInput = document.createElement("input");
        this._nameInput.type = "text";
        this._nameInput.maxLength = 24;
        this._nameInput.value = this._name;
        this._nameInput.addEventListener("change", () => {
            const value: string = this._nameInput.value.trim().slice(0, 24);
            this._name = value == "" ? makeGuestName() : value;
            this._nameInput.value = this._name;
            localStorage.setItem("abyssbox-pro-multiplayer-name", this._name);

            if (this._connected) {
                this._send({
                    type: "profile",
                    clientId: this._clientId,
                    name: this._name,
                });
            }
        });

        const roomRow: HTMLDivElement = this._makeRow("Room", this._roomInput);
        const nameRow: HTMLDivElement = this._makeRow("Name", this._nameInput);

        this._createButton = document.createElement("button");
        this._createButton.type = "button";
        this._createButton.textContent = "Create Room";
        this._createButton.addEventListener("click", () => {
            const room: string = makeRoomCode();
            this._roomInput.value = room;
            this.connect(room);
        });

        this._joinButton = document.createElement("button");
        this._joinButton.type = "button";
        this._joinButton.textContent = "Join";
        this._joinButton.addEventListener("click", () => {
            this.connect(this._roomInput.value);
        });

        this._copyButton = document.createElement("button");
        this._copyButton.type = "button";
        this._copyButton.textContent = "Copy Invite";
        this._copyButton.disabled = true;
        this._copyButton.addEventListener("click", async () => {
            if (this._room == "") return;

            const url: URL = new URL(window.location.href);
            url.searchParams.set("room", this._room);
            url.hash = "";

            try {
                await navigator.clipboard.writeText(url.toString());
                this._setStatus("Invite copied");
            } catch {
                window.prompt("Copy this invite link:", url.toString());
            }
        });

        this._leaveButton = document.createElement("button");
        this._leaveButton.type = "button";
        this._leaveButton.textContent = "Leave";
        this._leaveButton.disabled = true;
        this._leaveButton.addEventListener("click", () => {
            this.disconnect(true);
        });

        const actions: HTMLDivElement = document.createElement("div");
        actions.className = "abyssboxMultiplayerActions";
        actions.append(
            this._createButton,
            this._joinButton,
            this._copyButton,
            this._leaveButton,
        );

        this._users = document.createElement("div");
        this._users.className = "abyssboxMultiplayerUsers";
        this._users.textContent = "Nobody else here yet.";

        this._panel.append(title, this._status, roomRow, nameRow, actions, this._users);
        document.body.appendChild(this._panel);

        const versionArea: Element | null = editorRoot.querySelector(".version-area");
        if (versionArea != null) {
            versionArea.appendChild(this._button);
        } else {
            editorRoot.appendChild(this._button);
        }

        this._doc.notifier.watch(this._whenDocumentUpdated);

        const roomFromUrl: string = cleanRoomCode(new URLSearchParams(window.location.search).get("room") || "");
        if (roomFromUrl != "") {
            this._roomInput.value = roomFromUrl;
            window.setTimeout(() => this.connect(roomFromUrl), 0);
        }
    }

    private _makeRow(label: string, control: HTMLElement): HTMLDivElement {
        const row: HTMLDivElement = document.createElement("div");
        row.className = "abyssboxMultiplayerRow";

        const labelElement: HTMLSpanElement = document.createElement("span");
        labelElement.textContent = label + ":";

        row.append(labelElement, control);
        return row;
    }

    private _setStatus(message: string): void {
        this._status.textContent = message;
    }

    private _renderUsers(): void {
        this._users.replaceChildren();

        const header: HTMLDivElement = document.createElement("div");
        const count: number = this._usersListCount();
        header.textContent = count == 1 ? "1 person in room" : count + " people in room";
        this._users.appendChild(header);

        for (const user of this._roomUsers) {
            const row: HTMLDivElement = document.createElement("div");
            row.className = "abyssboxMultiplayerUser";

            const dot: HTMLSpanElement = document.createElement("span");
            dot.className = "abyssboxMultiplayerDot";

            const name: HTMLSpanElement = document.createElement("span");
            name.textContent = user.name + (user.id == this._clientId ? " (you)" : "");

            row.append(dot, name);
            this._users.appendChild(row);
        }
    }

    private _usersListCount(): number {
        return this._roomUsers.length;
    }

    private _send(data: unknown): void {
        if (this._socket == null || this._socket.readyState != WebSocket.OPEN) return;
        this._socket.send(JSON.stringify(data));
    }

    private _whenDocumentUpdated = (): void => {
        if (!this._connected || this._applyingRemote) return;

        const song: string = this._doc.song.toBase64String();
        if (song == this._lastSong) return;

        if (this._syncTimer != null) {
            window.clearTimeout(this._syncTimer);
        }

        this._syncTimer = window.setTimeout(() => {
            this._syncTimer = null;

            if (!this._connected) return;

            const latestSong: string = this._doc.song.toBase64String();
            if (latestSong == this._lastSong) return;

            this._lastSong = latestSong;

            this._send({
                type: "state",
                clientId: this._clientId,
                baseRevision: this._revision,
                song: latestSong,
                bar: this._doc.bar,
                channel: this._doc.channel,
            });
        }, syncDelayMs);
    };

    private _applyRemoteSong(song: string): void {
        if (song == "" || song == this._doc.song.toBase64String()) {
            this._lastSong = song;
            return;
        }

        this._applyingRemote = true;
        this._lastSong = song;

        try {
            new ChangeSong(this._doc, song);
            this._doc.notifier.notifyWatchers();

            if (this._doc.prefs.displayBrowserUrl) {
                const url: URL = new URL(window.location.href);
                url.hash = song;
                window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
            }
        } catch (error) {
            console.warn("Could not apply multiplayer song state:", error);
            this._setStatus("Could not apply room update");
        } finally {
            this._applyingRemote = false;
        }
    }

    private _handleMessage(message: ServerMessage): void {
        if (message.type == "welcome") {
            this._revision = message.revision;
            this._roomUsers = message.users;
            this._room = message.room;
            this._roomInput.value = message.room;
            this._applyRemoteSong(message.song);
            this._renderUsers();
            this._setStatus("Connected · " + message.room);
            this._copyButton.disabled = false;
            this._leaveButton.disabled = false;
            setRoomInUrl(message.room);
            return;
        }

        if (message.type == "state") {
            this._revision = Math.max(this._revision, message.revision);

            if (message.clientId != this._clientId) {
                this._applyRemoteSong(message.song);
            } else {
                this._lastSong = message.song;
            }

            return;
        }

        if (message.type == "presence") {
            this._roomUsers = message.users;
            this._renderUsers();
            return;
        }

        if (message.type == "error") {
            this._setStatus(message.message);
        }
    }

    public connect(roomValue: string): void {
        const room: string = cleanRoomCode(roomValue);
        if (room == "") {
            this._setStatus("Enter a room code");
            return;
        }

        if (multiplayerWorkerUrl.startsWith("PASTE_")) {
            this._setStatus("Set the Cloudflare Worker URL first");
            return;
        }

        this.disconnect(false);
        this._room = room;
        this._roomInput.value = room;
        this._setStatus("Connecting to " + room + "...");

        let socketUrl: string;

        try {
            socketUrl = websocketUrl(multiplayerWorkerUrl, room);
        } catch {
            this._setStatus("Invalid multiplayer server URL");
            return;
        }

        const socket: WebSocket = new WebSocket(socketUrl);
        this._socket = socket;

        socket.addEventListener("open", () => {
            if (socket != this._socket) return;

            this._connected = true;
            this._lastSong = this._doc.song.toBase64String();

            this._send({
                type: "hello",
                clientId: this._clientId,
                name: this._name,
                song: this._lastSong,
            });
        });

        socket.addEventListener("message", (event: MessageEvent) => {
            if (socket != this._socket || typeof event.data != "string") return;

            try {
                this._handleMessage(JSON.parse(event.data) as ServerMessage);
            } catch (error) {
                console.warn("Invalid multiplayer message:", error);
            }
        });

        socket.addEventListener("close", () => {
            if (socket != this._socket) return;

            this._connected = false;
            this._socket = null;
            this._copyButton.disabled = true;
            this._leaveButton.disabled = true;
            this._setStatus("Disconnected");
        });

        socket.addEventListener("error", () => {
            if (socket != this._socket) return;
            this._setStatus("Connection error");
        });
    }

    public disconnect(removeRoomFromUrl: boolean = false): void {
        if (this._syncTimer != null) {
            window.clearTimeout(this._syncTimer);
            this._syncTimer = null;
        }

        const socket: WebSocket | null = this._socket;
        this._socket = null;
        this._connected = false;
        this._revision = 0;
        this._roomUsers = [];
        this._copyButton.disabled = true;
        this._leaveButton.disabled = true;

        if (socket != null) {
            socket.close(1000, "Left room");
        }

        if (removeRoomFromUrl) {
            this._room = "";
            setRoomInUrl(null);
            this._renderUsers();
            this._setStatus("Not connected");
        }
    }
}
