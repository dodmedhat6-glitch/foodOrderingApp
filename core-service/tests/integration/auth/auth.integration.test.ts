import 'reflect-metadata';
import request from "supertest";
// Must come before the src/app import: it swaps the Mailjet provider for the
// stub in the DI container, and routes resolve their controllers on import.
import {emailStub} from "../../helpers/container";
import {truncateAll} from "../../helpers/db";

import {createApp} from "../../../src/app";
import {db} from "../../../src/lib/knex/kenx";
import {HashPassword} from "../../../src/app/auth/utils";

const app = createApp();

describe('POST /api/auth/forget-password', () => {
    beforeEach(async () => {
        //AAA pattern -> Arrange, Act, Assert
        await truncateAll();
        emailStub.reset();
    })

    afterAll(async () => {
        await db.destroy();
    })

    it('should send reset password email', async () => {
        // Arrange
        const now = new Date();
        await db('users').insert({
            email: 'test@example.com',
            phone: '1234567890',
            name: 'Test User',
            password_hash: await HashPassword('password123'),
            system_role: 'customer',
            created_at: now,
            updated_at: now
        });

        // Act
        const res = await request(app)
            .post('/api/auth/forget-password')
            .set('Idempotency-Key', `test-key-${Date.now()}`)
            .send({ email: 'test@example.com' });

        // Assert
        expect(res.status).toBe(200);
        expect(await db('password_reset').count('* as n').first()).toEqual({ n: '1' });
        expect(emailStub.sent).toHaveLength(1);
        expect(emailStub.sent[0].to).toBe('test@example.com');
    })
})
