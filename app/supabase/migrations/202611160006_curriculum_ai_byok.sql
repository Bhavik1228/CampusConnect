create table public.curriculum_ai_provider_configs (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  provider text not null check (provider in ('openai-compatible', 'google-gemini', 'anthropic')),
  endpoint_id text not null default 'openai'
    check (endpoint_id in ('openai', 'openrouter', 'groq', 'together', 'deepseek', 'mistral', 'fireworks', 'cerebras')),
  model text not null check (char_length(trim(model)) between 1 and 120),
  api_key_ciphertext text not null,
  api_key_nonce text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (provider = 'openai-compatible' or endpoint_id = 'openai')
);

create unique index curriculum_ai_school_provider_idx
  on public.curriculum_ai_provider_configs(school_id, provider)
  where user_id is null;
create unique index curriculum_ai_user_provider_idx
  on public.curriculum_ai_provider_configs(school_id, user_id, provider)
  where user_id is not null;

alter table public.curriculum_ai_provider_configs enable row level security;
revoke all on public.curriculum_ai_provider_configs from anon, authenticated;
grant select, insert, update, delete on public.curriculum_ai_provider_configs to service_role;
