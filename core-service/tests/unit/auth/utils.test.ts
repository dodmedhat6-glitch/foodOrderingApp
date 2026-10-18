import {HashPassword , comparePassword} from "../../../src/app/auth/utils";

describe('comparePassword', () => {
  it('should return true for valid password', async () => {
    const password = 'password123';
    const hashedPassword = await HashPassword(password);
    const result = await comparePassword(password, hashedPassword);
    expect(result).toBe(true);
  });

  it('should return false for invalid password', async () => {
    const password = 'password123';
    const hashedPassword = await HashPassword(password);
    const result = await comparePassword('wrongpassword', hashedPassword);
    expect(result).toBe(false);
  });
});
