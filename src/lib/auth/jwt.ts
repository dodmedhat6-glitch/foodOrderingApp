import { env } from '../config/env';
import jwt, { SignOptions } from 'jsonwebtoken';

export interface JwtPayload {
  user_id: number;
  email: string;
  role: string;

  // restaurant-user tokens only
  restaurantId?: number;
  restaurantRole?: string;
  branchIds?: number[];
}

export function createAccessToken(payload: JwtPayload): string {
  const options: SignOptions = { expiresIn: env.jwt.accessExpires as SignOptions['expiresIn'] };
  return jwt.sign(payload, env.jwt.accessSecret, options);
}

export function createRefreshToken(payload: JwtPayload): string {
  const options: SignOptions = { expiresIn: env.jwt.refreshExpires as SignOptions['expiresIn'] };
  return jwt.sign(payload, env.jwt.refreshSecret, options);
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, env.jwt.accessSecret) as JwtPayload;
}

export function verifyRefreshToken(token: string): JwtPayload {
  return jwt.verify(token, env.jwt.refreshSecret) as JwtPayload;
}
