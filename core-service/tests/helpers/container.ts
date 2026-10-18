/**
 * Swaps real infrastructure providers for test doubles.
 *
 * The email provider is not a module-level singleton that can be jest.mock'd -
 * it is injected through tsyringe under `tokens.EmailProvider` (see
 * src/lib/di/containers.ts). Importing this module registers the stub over the
 * real Mailjet instance. It MUST be imported before `src/app`, because
 * src/app/auth/routes.ts resolves its controller at module load time.
 */
import 'reflect-metadata';
import {container} from '../../src/lib/di/containers';
import {tokens} from '../../src/lib/di/tokens';
import {emailStub} from './email.stub';

container.registerInstance(tokens.EmailProvider, emailStub);

export {container, emailStub};
