import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';

const { types } = require('./proto');
const { toLong } = require('./utils');

const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const TOKEN_BODY_MIN_LENGTH = 64;
const TOKEN_BODY_MAX_LENGTH = 127;

export function generateGatewayRequestToken(): string {
    const length = crypto.randomInt(TOKEN_BODY_MIN_LENGTH, TOKEN_BODY_MAX_LENGTH + 1);
    let token = '';
    for (let index = 0; index < length; index += 1) {
        token += TOKEN_ALPHABET[crypto.randomInt(TOKEN_ALPHABET.length)];
    }
    return `${token}=`;
}

export class GatewayTokenProvider {
    private pendingInitToken = '';

    stageInitToken(value: unknown): number {
        const token = String(value || '').trim();
        if (!token) return 0;
        if (token.length > 64 * 1024 || !/^[\x21-\x7E]+$/.test(token)) {
            throw new Error('TSDK 初始化凭据格式无效');
        }
        this.pendingInitToken = token;
        return token.length;
    }

    next(): string {
        if (!this.pendingInitToken) return generateGatewayRequestToken();
        const token = this.pendingInitToken;
        this.pendingInitToken = '';
        return token;
    }

    clear(): void {
        this.pendingInitToken = '';
    }
}

export function encodeGatewayRequest(
    serviceName: string,
    methodName: string,
    bodyBytes: Uint8Array | null | undefined,
    clientSeq: unknown,
    serverSeq: unknown,
    token = generateGatewayRequestToken(),
): Uint8Array {
    const message = types.GateMessage.create({
        meta: {
            service_name: serviceName,
            method_name: methodName,
            message_type: 1,
            client_seq: toLong(clientSeq),
            server_seq: toLong(serverSeq),
        },
        body: bodyBytes || Buffer.alloc(0),
        token,
    });
    return types.GateMessage.encode(message).finish();
}
