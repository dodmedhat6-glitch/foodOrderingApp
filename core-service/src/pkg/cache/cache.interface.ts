export interface ICacheProvider {
    get(key: string): Promise<any>;
    set(key: string, value: string, ttlSeconds?: number): Promise<any>;
    del(key: string): Promise<any>;
}