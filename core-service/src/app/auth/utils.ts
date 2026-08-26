import { env } from '../../common/config/env'
import jwt, { SignOptions } from "jsonwebtoken"
import bcrypt from 'bcrypt'
import { createHash, randomInt } from 'node:crypto'
export async function HashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 10)

}

export interface JwtPayload {
    user_id: number;
    email: string;
    role: string;
}

export function creatAccessToken(payload: JwtPayload): string {
    const options: SignOptions = {
        expiresIn: env.jwt.accessExpires as SignOptions["expiresIn"]
    }
    return jwt.sign(payload, env.jwt.accessSecret, options)

}

export function creatRefreshToken(payload: JwtPayload): string {
    const options: SignOptions = {
        expiresIn: env.jwt.refreshExpires as SignOptions["expiresIn"]
    }
    return jwt.sign(payload, env.jwt.refreshSecret, options)

}

export function  verifyAccessToken(token : string): JwtPayload {
    return jwt.verify(token , env.jwt.accessSecret) as JwtPayload;
}

export function  verifyRefreshToken(token : string): JwtPayload {
    return jwt.verify(token , env.jwt.refreshSecret) as JwtPayload;
}

export function comparePassword(password: string, hashedPassword: string) {
    return bcrypt.compare(password, hashedPassword)
}

export function generateOTP(): string {
    return randomInt(100000, 1000000).toString()
}

export function hashOTP(otp: string): string {
    return createHash('sha256').update(otp).digest('hex')
}