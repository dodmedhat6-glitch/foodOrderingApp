export class PasswordReset {
  id: number;
  userId: number;
  otpHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;

  constructor(data: Partial<PasswordReset>) {
    this.id = data.id!;
    this.userId = data.userId!;
    this.otpHash = data.otpHash!;
    this.expiresAt = data.expiresAt!;
    this.consumedAt = data.consumedAt!;
    this.createdAt = data.createdAt!;
  }

  isExpired(): boolean {
    return this.expiresAt < new Date();
  }
}
