-- Hermes — schéma initial.
-- Exécuté automatiquement par Postgres au premier démarrage du volume.
-- Pour les évolutions ultérieures, ajoute des fichiers de migration
-- (deploy/migrations/) plutôt que de modifier celui-ci : il ne rejoue pas.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Un utilisateur. Mono-utilisateur au départ, mais la table existe déjà
-- pour que le passage au multi-utilisateurs ne soit pas une migration douloureuse.
CREATE TABLE IF NOT EXISTS users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    handle      TEXT UNIQUE NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Un fil de discussion.
CREATE TABLE IF NOT EXISTS conversations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT,
    -- 'text' | 'voice' : par quel mode la conversation a démarré
    mode        TEXT NOT NULL DEFAULT 'text',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_user_updated_idx
    ON conversations (user_id, updated_at DESC);

-- Un tour de parole. `content` stocke les content blocks Anthropic bruts
-- (JSON), pas juste du texte : on garde les tool_use / thinking intacts
-- pour pouvoir rejouer l'historique fidèlement.
CREATE TABLE IF NOT EXISTS messages (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role             TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content          JSONB NOT NULL,
    -- Trace de coût, alimentée depuis usage.* des réponses API
    input_tokens     INTEGER,
    output_tokens    INTEGER,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
    ON messages (conversation_id, created_at);

-- Mémoire long terme : faits que Hermes retient entre les sessions.
-- Un fait par ligne, pour pouvoir en corriger ou en supprimer un seul.
CREATE TABLE IF NOT EXISTS memories (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- 'preference' | 'fact' | 'project' | 'contact' ...
    kind        TEXT NOT NULL DEFAULT 'fact',
    content     TEXT NOT NULL,
    source      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memories_user_idx ON memories (user_id, kind);

-- L'utilisateur par défaut du mode mono-utilisateur.
INSERT INTO users (handle) VALUES ('tom')
    ON CONFLICT (handle) DO NOTHING;
