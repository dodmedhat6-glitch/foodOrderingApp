import {mailjetProvider} from "../../pkg/email/mailjet";
import {env} from "../config/env";

export const emailProvider = new mailjetProvider({
    apiKey: env.mailjet.apiKey,
    secretKey: env.mailjet.secretKey,
    fromEmail: env.mailjet.fromEmail,
    fromName: env.mailjet.fromName,
});
