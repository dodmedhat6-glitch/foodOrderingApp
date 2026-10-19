import {IEmailProvider} from "../../src/pkg/email/email.interface";

export class EmailStub implements IEmailProvider {
    sent: { to: string, subject: string, body: string }[] = [];

    async sendEmail(to: string, subject: string, body: string): Promise<void> {
        this.sent.push({to, subject, body});
    }

    reset(): void {
        this.sent = [];
    }
}

export const emailStub = new EmailStub();