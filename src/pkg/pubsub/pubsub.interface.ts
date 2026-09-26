export type PubSubHandler = (channel: string, payload: string) => void;

export interface IPubSubProvider {
  publish(channel: string, payload: string): Promise<void>;
  psubscribe(pattern: string, handler: PubSubHandler): Promise<void>;
  quit(): Promise<void>;
}
