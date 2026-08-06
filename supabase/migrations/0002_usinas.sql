-- Usinas criadas na plataforma (fora do Forecast 6+6). Mutável, auditada.
-- Recurso RLS: 'cadastro_uc' (Asset analyst+ cria/edita).
create table usinas_cadastro (
  id           uuid primary key default gen_random_uuid(),
  usina        text not null unique,
  cliente      text,
  disco        text,
  pot_mwac     numeric,
  pot_mwp      numeric,
  desconto     numeric,          -- fração (0.35)
  p50_ano      numeric,          -- MWh/ano
  cod          date,             -- energização/COD
  take_or_pay  boolean not null default false,
  perf_oper    numeric,
  ativo        boolean not null default true,
  observacao   text,
  created_by   uuid references profiles(id),
  updated_by   uuid references profiles(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger trg_touch_usinas_cadastro before insert or update on usinas_cadastro
  for each row execute function fn_touch();
create trigger trg_audit_usinas_cadastro after insert or update or delete on usinas_cadastro
  for each row execute function fn_audit();

alter table usinas_cadastro enable row level security;
create policy usinas_read   on usinas_cadastro for select using (has_perm('cadastro_uc','read'));
create policy usinas_insert on usinas_cadastro for insert with check (has_perm('cadastro_uc','write'));
create policy usinas_update on usinas_cadastro for update using (has_perm('cadastro_uc','write'));
create policy usinas_delete on usinas_cadastro for delete using (has_perm('cadastro_uc','admin'));
