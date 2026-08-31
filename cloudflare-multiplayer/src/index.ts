import { DurableObject } from "cloudflare:workers";

interface Env {
    ROOMS: DurableObjectNamespace<Room>;
    ALLOWED_ORIGINS?: string;
}

interface ClientAttachment {
    clientId: string;
    name: string;
}

interface HelloMessage {
    type: "hello";
    clientId: string;
    name: string;
    song: string;
}

interface ProfileMessage {
    type: "profile";
    clientId: string;
    name: string;
}

interface StateMessage {
    type: "state";
    clientId: string;
    baseRevision: number;
    song: string;
    bar?: number;
    channel?: number;
}

type ClientMessage = HelloMessage | ProfileMessage | StateMessage;

const maxSongLength: number = 2_000_000;
const maxNameLength: number = 24;

function json(data: unknown, status: number = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
        },
    });
}

function cleanRoom(value: string): string {
    return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20);
}

function cleanName(value: string): string {
    const trimmed: string = value.trim().slice(0, maxNameLength);
    return trimmed == "" ? "Guest" : trimmed;
}

function originAllowed(request: Request, env: Env): boolean {
    const configured: string = env.ALLOWED_ORIGINS || "";
    if (configured.trim() == "") return true;

    const origin: string = request.headers.get("Origin") || "";
    if (origin == "") return true;

    const allowed: string[] = configured
        .split(",")
        .map((value: string) => value.trim())
        .filter((value: string) => value != "");

    return allowed.includes(origin);
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url: URL = new URL(request.url);

        if (url.pathname == "/health") {
            return json({
                ok: true,
                service: "AbyssBox Pro Multiplayer",
            });
        }

        if (!originAllowed(request, env)) {
            return json({ error: "Origin not allowed." }, 403);
        }

        const match: RegExpMatchArray | null = url.pathname.match(/^\/room\/([A-Za-z0-9]+)$/);

        if (match == null) {
            return json({
                error: "Not found.",
                usage: "/room/ROOMCODE",
            }, 404);
        }

        if (request.headers.get("Upgrade")?.toLowerCase() != "websocket") {
            return json({ error: "WebSocket upgrade required." }, 426);
        }

        const room: string = cleanRoom(match[1]);
        if (room.length < 3) {
            return json({ error: "Invalid room code." }, 400);
        }

        const id: DurableObjectId = env.ROOMS.idFromName(room);
        const stub: DurableObjectStub<Room> = env.ROOMS.get(id);

        const headers: Headers = new Headers(request.headers);
        headers.set("X-AbyssBox-Room", room);

        return stub.fetch(new Request(request.url, {
            method: request.method,
            headers,
        }));
    },
};

export class Room extends DurableObject<Env> {
    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
    }

    private _getAttachment(socket: WebSocket): ClientAttachment {
        const attachment: ClientAttachment | null = socket.deserializeAttachment() as ClientAttachment | null;

        return attachment || {
            clientId: "",
            name: "Guest",
        };
    }

    private _getUsers(): {id: string; name: string}[] {
        const users: {id: string; name: string}[] = [];
        const seen: Set<string> = new Set();

        for (const socket of this.ctx.getWebSockets()) {
            const attachment: ClientAttachment = this._getAttachment(socket);
            if (attachment.clientId == "" || seen.has(attachment.clientId)) continue;

            seen.add(attachment.clientId);
            users.push({
                id: attachment.clientId,
                name: attachment.name,
            });
        }

        return users;
    }

    private _broadcast(data: unknown, except: WebSocket | null = null): void {
        const message: string = JSON.stringify(data);

        for (const socket of this.ctx.getWebSockets()) {
            if (socket == except) continue;

            try {
                socket.send(message);
            } catch {
            }
        }
    }

    private _broadcastPresence(): void {
        this._broadcast({
            type: "presence",
            users: this._getUsers(),
        });
    }

    async fetch(request: Request): Promise<Response> {
        if (request.headers.get("Upgrade")?.toLowerCase() != "websocket") {
            return json({ error: "WebSocket upgrade required." }, 426);
        }

        const pair: WebSocketPair = new WebSocketPair();
        const client: WebSocket = pair[0];
        const server: WebSocket = pair[1];

        const room: string = cleanRoom(request.headers.get("X-AbyssBox-Room") || "");
        if (room != "") {
            await this.ctx.storage.put("room", room);
        }

        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({
            clientId: "",
            name: "Guest",
        } satisfies ClientAttachment);

        return new Response(null, {
            status: 101,
            webSocket: client,
        });
    }

    async webSocketMessage(socket: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
        if (typeof rawMessage != "string") return;

        let message: ClientMessage;

        try {
            message = JSON.parse(rawMessage) as ClientMessage;
        } catch {
            socket.send(JSON.stringify({
                type: "error",
                message: "Invalid multiplayer message.",
            }));
            return;
        }

        if (message.type == "hello") {
            const attachment: ClientAttachment = {
                clientId: message.clientId.slice(0, 100),
                name: cleanName(message.name),
            };

            socket.serializeAttachment(attachment);

            let song: string = await this.ctx.storage.get<string>("song") || "";
            let revision: number = await this.ctx.storage.get<number>("revision") || 0;

            if (song == "") {
                if (message.song.length > maxSongLength) {
                    socket.send(JSON.stringify({
                        type: "error",
                        message: "Song is too large for this multiplayer beta.",
                    }));
                    return;
                }

                song = message.song;
                revision = 1;

                await this.ctx.storage.put({
                    song,
                    revision,
                });
            }

            socket.send(JSON.stringify({
                type: "welcome",
                room: await this.ctx.storage.get<string>("room") || "ROOM",
                song,
                revision,
                users: this._getUsers(),
            }));

            this._broadcastPresence();
            return;
        }

        if (message.type == "profile") {
            const current: ClientAttachment = this._getAttachment(socket);

            socket.serializeAttachment({
                clientId: current.clientId || message.clientId.slice(0, 100),
                name: cleanName(message.name),
            } satisfies ClientAttachment);

            this._broadcastPresence();
            return;
        }

        if (message.type == "state") {
            const attachment: ClientAttachment = this._getAttachment(socket);

            if (attachment.clientId == "" || attachment.clientId != message.clientId) {
                socket.send(JSON.stringify({
                    type: "error",
                    message: "Client identity mismatch.",
                }));
                return;
            }

            if (typeof message.song != "string" || message.song.length == 0 || message.song.length > maxSongLength) {
                socket.send(JSON.stringify({
                    type: "error",
                    message: "Invalid or oversized song state.",
                }));
                return;
            }

            const revision: number = (await this.ctx.storage.get<number>("revision") || 0) + 1;

            await this.ctx.storage.put({
                song: message.song,
                revision,
            });

            this._broadcast({
                type: "state",
                song: message.song,
                revision,
                clientId: message.clientId,
            });

            return;
        }
    }

    async webSocketClose(
        _socket: WebSocket,
        _code: number,
        _reason: string,
        _wasClean: boolean,
    ): Promise<void> {
        this._broadcastPresence();
    }

    async webSocketError(_socket: WebSocket, _error: unknown): Promise<void> {
        this._broadcastPresence();
    }
}
