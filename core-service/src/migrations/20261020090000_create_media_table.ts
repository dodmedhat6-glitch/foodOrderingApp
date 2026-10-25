import type { Knex } from "knex";

/**
 * Media uploaded for a restaurant (logos, product images). `media_path` holds
 * the S3 object key rather than a URL: the bucket is private, so the browser
 * URL is a presigned one minted per read (app/media/service/media.service.ts).
 *
 * Rows are tombstoned (status = 'deleted'), never hard-deleted, so references
 * from other tables stay resolvable and the upload is still auditable.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.raw(`
        CREATE TABLE media (
            id BIGSERIAL PRIMARY KEY,
            restaurant_id BIGINT NOT NULL,
            uploaded_by BIGINT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'ready', 'failed', 'deleted')),
            media_path TEXT NOT NULL UNIQUE,
            content_type TEXT NOT NULL,
            size_bytes BIGINT NOT NULL DEFAULT 0,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),

            CONSTRAINT fk_media_restaurant_id FOREIGN KEY (restaurant_id)
                REFERENCES restaurants(id) ON DELETE CASCADE,
            CONSTRAINT fk_media_uploaded_by FOREIGN KEY (uploaded_by)
                REFERENCES users(id)
        );

        CREATE INDEX idx_media_restaurant_id ON media(restaurant_id);
        CREATE INDEX idx_media_status ON media(status);
        CREATE INDEX idx_media_uploaded_by ON media(uploaded_by);
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.raw(`
        DROP TABLE IF EXISTS media;
    `);
}
