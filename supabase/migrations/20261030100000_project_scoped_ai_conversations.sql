-- One private, durable AI conversation per FELTUS project for the current
-- authenticated owner. Conversation and message ownership is enforced in RLS.

CREATE TABLE IF NOT EXISTS public.feltus_ai_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID NOT NULL
        REFERENCES public.feltus_applications(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL,
    created_by UUID NOT NULL,
    title TEXT NOT NULL DEFAULT 'Project conversation'
        CHECK (char_length(title) BETWEEN 1 AND 120),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (app_id, owner_id)
);

CREATE INDEX IF NOT EXISTS feltus_ai_conversations_owner_updated_idx
    ON public.feltus_ai_conversations (owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.feltus_ai_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL
        REFERENCES public.feltus_ai_conversations(id) ON DELETE CASCADE,
    app_id UUID NOT NULL
        REFERENCES public.feltus_applications(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL
        CHECK (char_length(content) BETWEEN 1 AND 40000),
    model TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feltus_ai_messages_project_created_idx
    ON public.feltus_ai_messages (app_id, conversation_id, created_at ASC);

ALTER TABLE public.feltus_ai_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_ai_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS feltus_ai_conversations_owner_policy
    ON public.feltus_ai_conversations;
CREATE POLICY feltus_ai_conversations_owner_policy
    ON public.feltus_ai_conversations
    FOR ALL TO authenticated
    USING (
        owner_id = auth.uid()
        AND EXISTS (
            SELECT 1
            FROM public.feltus_applications app
            WHERE app.id = feltus_ai_conversations.app_id
              AND app.owner_id = auth.uid()
        )
    )
    WITH CHECK (
        owner_id = auth.uid()
        AND created_by = auth.uid()
        AND EXISTS (
            SELECT 1
            FROM public.feltus_applications app
            WHERE app.id = feltus_ai_conversations.app_id
              AND app.owner_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS feltus_ai_messages_owner_policy
    ON public.feltus_ai_messages;
CREATE POLICY feltus_ai_messages_owner_policy
    ON public.feltus_ai_messages
    FOR ALL TO authenticated
    USING (
        owner_id = auth.uid()
        AND EXISTS (
            SELECT 1
            FROM public.feltus_ai_conversations conversation
            JOIN public.feltus_applications app
              ON app.id = conversation.app_id
            WHERE conversation.id = feltus_ai_messages.conversation_id
              AND conversation.app_id = feltus_ai_messages.app_id
              AND conversation.owner_id = auth.uid()
              AND app.owner_id = auth.uid()
        )
    )
    WITH CHECK (
        owner_id = auth.uid()
        AND EXISTS (
            SELECT 1
            FROM public.feltus_ai_conversations conversation
            JOIN public.feltus_applications app
              ON app.id = conversation.app_id
            WHERE conversation.id = feltus_ai_messages.conversation_id
              AND conversation.app_id = feltus_ai_messages.app_id
              AND conversation.owner_id = auth.uid()
              AND app.owner_id = auth.uid()
        )
    );

REVOKE ALL ON public.feltus_ai_conversations FROM anon;
REVOKE ALL ON public.feltus_ai_messages FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE
    ON public.feltus_ai_conversations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
    ON public.feltus_ai_messages TO authenticated;

NOTIFY pgrst, 'reload schema';
