import { DurableObject } from "cloudflare:workers";

interface Env {
    ROOMS: DurableObjectNamespace<Room>;
    ASSETS: R2Bucket;
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

interface CursorMessage {
    type: "cursor";
    clientId: string;
    x: number;
    y: number;
    visible: boolean;
    channel: number;
    bar: number;
}

type ClientMessage = HelloMessage | ProfileMessage | StateMessage | CursorMessage;

const maxSongLength: number = 2_000_000;
const maxNameLength: number = 24;
const maxSoundFontBytes: number = 64 * 1024 * 1024;
const soundFontPathRegex: RegExp = /^\/assets\/soundfont\/([a-f0-9]{64})\.sf2$/i;

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

function corsHeaders(request: Request, env: Env): Headers {
    const headers: Headers = new Headers();
    const origin: string = request.headers.get("Origin") || "";

    if (origin != "" && originAllowed(request, env)) {
        headers.set("access-control-allow-origin", origin);
        headers.set("vary", "Origin");
    }

    headers.set("access-control-allow-methods", "GET, HEAD, PUT, OPTIONS");
    headers.set("access-control-allow-headers", "content-type");
    headers.set("access-control-max-age", "86400");
    return headers;
}

function assetJson(request: Request, env: Env, data: unknown, status: number = 200): Response {
    const headers: Headers = corsHeaders(request, env);
    headers.set("content-type", "application/json; charset=utf-8");
    headers.set("cache-control", "no-store");

    return new Response(JSON.stringify(data), {
        status,
        headers,
    });
}

function isValidSoundFont(buffer: ArrayBuffer): boolean {
    if (buffer.byteLength < 12) return false;

    const bytes: Uint8Array = new Uint8Array(buffer, 0, 12);

    return (
        bytes[0] == 0x52 &&
        bytes[1] == 0x49 &&
        bytes[2] == 0x46 &&
        bytes[3] == 0x46 &&
        bytes[8] == 0x73 &&
        bytes[9] == 0x66 &&
        bytes[10] == 0x62 &&
        bytes[11] == 0x6b
    );
}

async function roomHasClient(env: Env, roomValue: string, clientId: string): Promise<boolean> {
    const room: string = cleanRoom(roomValue);
    if (room.length < 3 || clientId == "") return false;

    const id: DurableObjectId = env.ROOMS.idFromName(room);
    const stub: DurableObjectStub<Room> = env.ROOMS.get(id);

    const response: Response = await stub.fetch(
        new Request("https://internal/authorize-asset-upload", {
            method: "POST",
            headers: {
                "X-AbyssBox-Asset-Client": clientId.slice(0, 100),
            },
        }),
    );

    return response.ok;
}

async function handleSoundFontAsset(
    request: Request,
    env: Env,
    url: URL,
    hash: string,
): Promise<Response> {
    const objectKey: string = "soundfonts/" + hash.toLowerCase() + ".sf2";

    if (request.method == "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: corsHeaders(request, env),
        });
    }

    if (request.method == "GET" || request.method == "HEAD") {
        const object: R2ObjectBody | null = await env.ASSETS.get(objectKey);

        if (object == null) {
            return assetJson(request, env, {error: "SoundFont not found."}, 404);
        }

        const headers: Headers = corsHeaders(request, env);
        headers.set("content-type", "application/octet-stream");
        headers.set("content-length", object.size.toString());
        headers.set("cache-control", "public, max-age=31536000, immutable");
        headers.set("etag", object.httpEtag);

        if (request.method == "HEAD") {
            return new Response(null, {
                status: 200,
                headers,
            });
        }

        return new Response(object.body, {
            status: 200,
            headers,
        });
    }

    if (request.method != "PUT") {
        return assetJson(request, env, {error: "Method not allowed."}, 405);
    }

    const room: string = cleanRoom(url.searchParams.get("room") || "");
    const clientId: string = (url.searchParams.get("client") || "").slice(0, 100);

    if (!(await roomHasClient(env, room, clientId))) {
        return assetJson(request, env, {error: "Join the multiplayer room before sharing assets."}, 403);
    }

    const existing: R2Object | null = await env.ASSETS.head(objectKey);

    if (existing != null) {
        return assetJson(request, env, {
            ok: true,
            existed: true,
            url: new URL("/assets/soundfont/" + hash.toLowerCase() + ".sf2", request.url).toString(),
        });
    }

    const contentLength: number = Number(request.headers.get("content-length") || "0");

    if (Number.isFinite(contentLength) && contentLength > maxSoundFontBytes) {
        return assetJson(request, env, {error: "SoundFont is larger than the 64 MB multiplayer limit."}, 413);
    }

    const buffer: ArrayBuffer = await request.arrayBuffer();

    if (buffer.byteLength <= 0 || buffer.byteLength > maxSoundFontBytes) {
        return assetJson(request, env, {error: "SoundFont is empty or larger than the 64 MB multiplayer limit."}, 413);
    }

    if (!isValidSoundFont(buffer)) {
        return assetJson(request, env, {error: "That upload is not a valid SF2 SoundFont."}, 400);
    }

    const name: string = (url.searchParams.get("name") || "SoundFont").slice(0, 160);

    await env.ASSETS.put(objectKey, buffer, {
        httpMetadata: {
            contentType: "application/octet-stream",
            cacheControl: "public, max-age=31536000, immutable",
        },
        customMetadata: {
            name,
        },
    });

    return assetJson(request, env, {
        ok: true,
        existed: false,
        url: new URL("/assets/soundfont/" + hash.toLowerCase() + ".sf2", request.url).toString(),
    });
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url: URL = new URL(request.url);

        if (url.pathname == "/health") {
            return json({
                ok: true,
                service: "AbyssBox Pro Multiplayer",
                soundFontSharing: true,
            });
        }

        const soundFontMatch: RegExpMatchArray | null = url.pathname.match(soundFontPathRegex);

        if (soundFontMatch != null) {
            if (!originAllowed(request, env)) {
                return assetJson(request, env, {error: "Origin not allowed."}, 403);
            }

            return handleSoundFontAsset(request, env, url, soundFontMatch[1]);
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
        const url: URL = new URL(request.url);

        if (url.pathname == "/authorize-asset-upload" && request.method == "POST") {
            const clientId: string = (request.headers.get("X-AbyssBox-Asset-Client") || "").slice(0, 100);

            for (const socket of this.ctx.getWebSockets()) {
                const attachment: ClientAttachment = this._getAttachment(socket);

                if (attachment.clientId != "" && attachment.clientId == clientId) {
                    return json({ok: true});
                }
            }

            return json({error: "Client is not connected to this room."}, 403);
        }

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

        if (message.type == "cursor") {
            const attachment: ClientAttachment = this._getAttachment(socket);

            if (attachment.clientId == "" || attachment.clientId != message.clientId) {
                return;
            }

            const x: number = Math.max(0, Math.min(1, Number(message.x) || 0));
            const y: number = Math.max(0, Math.min(1, Number(message.y) || 0));
            const channel: number = Math.max(0, Math.min(255, Math.floor(Number(message.channel) || 0)));
            const bar: number = Math.max(0, Math.min(65_535, Math.floor(Number(message.bar) || 0)));

            this._broadcast({
                type: "cursor",
                clientId: attachment.clientId,
                name: attachment.name,
                x,
                y,
                visible: Boolean(message.visible),
                channel,
                bar,
            }, socket);

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
