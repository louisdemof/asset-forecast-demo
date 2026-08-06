-- ============================================================================
-- Asset Forecast — Supabase schema v1
-- ----------------------------------------------------------------------------
-- Princípio: o FORECAST (Forecast 6+6 / CSVs) continua READ-ONLY, versionado
-- no repo. O Supabase guarda só o que é MUTÁVEL e criado por pessoas:
--   1. Dados de domínio  : cadastro_uc, faturas_geradora, metodos_cliente, descontos_usina, validacoes_mensais
--   2. Modelo de usuário : departments, roles, role_permissions, profiles (RBAC estilo Salesforce)
--   3. Histórico         : audit_log (toda mudança) + user_activity (login/uso)
--
-- Tudo com RLS ligado. Permissão = função do (role × recurso × ação).
-- ============================================================================

create extension if not exists "pgcrypto";           -- gen_random_uuid()

-- ============================================================================
-- 1 · MODELO DE USUÁRIO (RBAC — Salesforce-like)
-- ============================================================================

-- Departamento (Asset, Comercial, Engenharia, O&M, Financeiro, Diretoria, TI)
create table departments (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null unique,
  descricao   text,
  created_at  timestamptz not null default now()
);

-- Papel / perfil de acesso. `nivel` dá a hierarquia (100 = admin, 10 = viewer).
create table roles (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null unique,
  nivel       int  not null default 10,
  descricao   text,
  created_at  timestamptz not null default now()
);

-- Matriz de permissões: por role e por recurso, o que pode fazer.
-- recurso ∈ {cadastro_uc, faturas, regras, validacoes, users}
create table role_permissions (
  role_id       uuid not null references roles(id) on delete cascade,
  recurso       text not null,
  can_read      boolean not null default false,
  can_write     boolean not null default false,   -- criar / editar
  can_validate  boolean not null default false,   -- assinar validação mensal
  can_admin     boolean not null default false,   -- apagar / gerir
  primary key (role_id, recurso)
);

-- Perfil do usuário — 1:1 com auth.users do Supabase.
-- manager_id = hierarquia (quem reporta a quem), como no Salesforce Role Hierarchy.
create table profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  nome          text not null,
  email         text not null unique,
  cargo         text,                              -- job title livre
  department_id uuid references departments(id),
  role_id       uuid references roles(id),
  manager_id    uuid references profiles(id),      -- self-ref: chefe direto
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index on profiles(department_id);
create index on profiles(role_id);
create index on profiles(manager_id);

-- ============================================================================
-- 2 · DADOS DE DOMÍNIO (mutável — o que a plataforma edita)
-- ============================================================================

-- 2a. Cadastro UC → usina (resolve a ambiguidade das 5 Pipas; roteia faturas)
create table cadastro_uc (
  id             uuid primary key default gen_random_uuid(),
  uc             text not null,                    -- código de instalação / matrícula
  w_codes        text[] not null default '{}',     -- W-codes EMS ligados à mesma UC
  usina          text not null,
  distribuidora  text,
  modelo         text,                             -- 'AR' | 'GC'
  tipo_cliente   text,                             -- Cliente A, Cliente B, ...
  fonte          text not null default 'manual',   -- 'manual' | 'meterhub' | 'fatura'
  observacao     text,
  created_by     uuid references profiles(id),
  updated_by     uuid references profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (uc, usina)
);
create index on cadastro_uc(usina);

-- 2b. Faturas da unidade geradora (GC fora da MeterHub) — upload/OCR pela Asset
create table faturas_geradora (
  id             uuid primary key default gen_random_uuid(),
  usina          text not null,
  mes            date not null,                    -- 1º dia do mês de competência
  distribuidora  text,
  uc             text,
  injecao_kwh    numeric,
  compensado_kwh numeric,
  banco_kwh      numeric,                          -- saldo do banco de créditos
  demanda_rs     numeric,                          -- custo da demanda de geração
  arquivo        text,                             -- caminho no Supabase Storage
  doc            text,                             -- 'EMS' | 'COSERN' | ...
  parsed         jsonb,                            -- payload bruto do parser
  status         text not null default 'rascunho', -- rascunho | confirmado | dividido
  flag           text,                             -- '2x' (mês dobrado), etc.
  created_by     uuid references profiles(id),
  updated_by     uuid references profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (usina, mes, uc)
);
create index on faturas_geradora(usina, mes);

-- 2c. MÉTODO de cálculo por cliente — editável na aba Métodos (fonte da verdade,
--     espelha e SUBSTITUI o REGRAS_CLIENTE hardcoded em src/engine/clientes.ts).
--     Seed inicial vem do código; a partir daí Asset/Comercial editam pela plataforma.
create table metodos_cliente (
  id               uuid primary key default gen_random_uuid(),
  cliente          text not null unique,              -- offtaker: offtaker: Cliente A, Cliente B, ...
  modelo           text,                              -- 'AR' | 'GC'
  gross_up         text,                              -- nenhum|pis|pis_icms|pis_icms_semdesc|split|plano|fixo
  base_formula     text,                              -- descrição/fórmula da base (R$/MWh)
  residual         text,                              -- 'O&M' | 'Guarda-Chuva'
  pis              boolean not null default false,    -- base é grossed-up por PIS?
  icms             boolean not null default false,    -- ...por ICMS?
  desconto_na_base boolean not null default true,     -- o desconto entra na base (1−desc)?
  take_or_pay      boolean,                           -- null = a confirmar
  cap_compensada   text,                              -- teto de compensação (a confirmar)
  fee_mwh          numeric not null default 0,        -- fee de operador GC (SION = 85 R$/MWh)
  reajuste_tipo    text not null default 'aneel',     -- 'aneel' | 'contratual'
  ativo            boolean not null default true,
  observacao       text,
  created_by       uuid references profiles(id),
  updated_by       uuid references profiles(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- 2c-bis. DESCONTO / PPA por usina — editável (fonte da verdade do desconto,
--     hoje preso no Contratos.csv). Também guarda o índice de reajuste do PPA (Pergunta 5.3).
create table descontos_usina (
  id                      uuid primary key default gen_random_uuid(),
  usina                   text not null unique,
  cliente                 text,
  distribuidora           text,
  precificacao            text not null default 'desconto', -- 'desconto' | 'ppa'
  desconto_pct            numeric,                    -- se precificacao='desconto' (ex.: 0.35)
  ppa_valor               numeric,                    -- se precificacao='ppa' (R$/MWh fixo)
  reajuste_indice         text,                       -- IPCA | IGP-M | custo_energia | aneel | manual
  reajuste_data_base      date,
  reajuste_mes_aniversario int,                       -- 1..12
  ativo                   boolean not null default true,
  observacao              text,
  created_by              uuid references profiles(id),
  updated_by              uuid references profiles(id),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index on descontos_usina(cliente);

-- 2d. Validação mensal do forecast — alguém da Asset assina o mês
create table validacoes_mensais (
  id           uuid primary key default gen_random_uuid(),
  mes          date not null,                      -- mês de referência
  escopo       text not null default 'portfolio',  -- 'portfolio' | 'usina'
  alvo         text,                               -- usina, se escopo = 'usina'
  status       text not null default 'pendente',   -- pendente | validado | rejeitado
  metricas     jsonb,                              -- snapshot (receita, energia, desvio...) no momento
  observacao   text,
  validated_by uuid references profiles(id),
  validated_at timestamptz,
  created_by   uuid references profiles(id),
  updated_by   uuid references profiles(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (mes, escopo, alvo)
);
create index on validacoes_mensais(mes);

-- ============================================================================
-- 3 · HISTÓRICO
-- ============================================================================

-- 3a. Modification history — toda mudança em tabela mutável (via trigger)
create table audit_log (
  id             bigint generated always as identity primary key,
  table_name     text not null,
  record_id      uuid,
  action         text not null,                    -- INSERT | UPDATE | DELETE
  changed_fields text[],                           -- só campos alterados (UPDATE)
  old_data       jsonb,
  new_data       jsonb,
  actor_id       uuid,
  actor_email    text,
  occurred_at    timestamptz not null default now()
);
create index on audit_log(table_name, record_id);
create index on audit_log(actor_id);
create index on audit_log(occurred_at desc);

-- 3b. User activity — login/uso (histórico do usuário além do que o auth guarda)
create table user_activity (
  id          bigint generated always as identity primary key,
  user_id     uuid references profiles(id),
  evento      text not null,                       -- login | logout | export | view | import
  detalhe     jsonb,
  ip          inet,
  occurred_at timestamptz not null default now()
);
create index on user_activity(user_id, occurred_at desc);

-- ============================================================================
-- 4 · FUNÇÕES & TRIGGERS
-- ============================================================================

-- 4a. touch: mantém updated_at / updated_by / created_by automaticamente
create or replace function fn_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
  end if;
  return new;
end $$;

-- 4b. audit: registra INSERT/UPDATE/DELETE em audit_log
-- search_path fixo em public: estas funções também disparam no contexto do schema
-- auth (signup → trg_new_user → insert em profiles → trg_audit), onde public não
-- estaria no path e as tabelas não seriam encontradas ("Database error saving new user").
create or replace function fn_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_actor  uuid := auth.uid();
  v_email  text;
  v_fields text[];
begin
  select email into v_email from auth.users where id = v_actor;

  if tg_op = 'UPDATE' then
    select array_agg(o.key) into v_fields
    from jsonb_each(to_jsonb(old)) o
    where o.value is distinct from (to_jsonb(new) -> o.key);
  end if;

  insert into public.audit_log(table_name, record_id, action, changed_fields, old_data, new_data, actor_id, actor_email)
  values (
    tg_table_name,
    case when tg_op = 'DELETE' then old.id else new.id end,
    tg_op,
    v_fields,
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end,
    v_actor, v_email
  );
  return case when tg_op = 'DELETE' then old else new end;
end $$;

-- 4c. novo auth.user → cria profile (viewer por padrão, inativo até um admin liberar)
create or replace function fn_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, nome, email, role_id, is_active)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    new.email,
    (select id from public.roles where nome = 'viewer'),
    false
  )
  on conflict (id) do nothing;
  return new;
end $$;

create trigger trg_new_user
  after insert on auth.users
  for each row execute function fn_new_user();

-- 4d. touch leve só de updated_at (para tabelas sem created_by/updated_by, ex. profiles)
create or replace function fn_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Aplica touch (created_by/updated_by/updated_at) + audit nas tabelas de domínio.
-- profiles NÃO tem colunas *_by → usa o touch leve; audit vale para todas.
do $$
declare t text;
begin
  foreach t in array array['cadastro_uc','faturas_geradora','metodos_cliente','descontos_usina','validacoes_mensais'] loop
    execute format('create trigger trg_touch_%1$s before insert or update on %1$s for each row execute function fn_touch();', t);
    execute format('create trigger trg_audit_%1$s after insert or update or delete on %1$s for each row execute function fn_audit();', t);
  end loop;
end $$;

create trigger trg_touch_profiles before update on profiles
  for each row execute function fn_touch_updated_at();
create trigger trg_audit_profiles after insert or update or delete on profiles
  for each row execute function fn_audit();

-- ============================================================================
-- 5 · PERMISSÕES (helper usado pelas RLS policies)
-- ============================================================================

-- has_perm(recurso, ação) — true se o usuário logado (e ativo) pode.
create or replace function has_perm(_recurso text, _acao text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(bool_or(
    case _acao
      when 'read'     then rp.can_read
      when 'write'    then rp.can_write
      when 'validate' then rp.can_validate
      when 'admin'    then rp.can_admin
      else false
    end), false)
  from public.profiles p
  join public.role_permissions rp on rp.role_id = p.role_id
  where p.id = auth.uid() and p.is_active and rp.recurso = _recurso;
$$;

-- ============================================================================
-- 6 · RLS
-- ============================================================================

-- Domínio: leitura por quem tem read; escrita por write; delete por admin.
do $$
declare
  t   text;
  res text;
  map jsonb := '{
    "cadastro_uc":"cadastro_uc",
    "faturas_geradora":"faturas",
    "metodos_cliente":"regras",
    "descontos_usina":"regras",
    "validacoes_mensais":"validacoes"
  }';
begin
  for t in select jsonb_object_keys(map) loop
    res := map->>t;
    execute format('alter table %I enable row level security;', t);
    execute format('create policy %1$s_read   on %1$s for select using (has_perm(%2$L,''read''));',  t, res);
    execute format('create policy %1$s_insert on %1$s for insert with check (has_perm(%2$L,''write''));', t, res);
    execute format('create policy %1$s_update on %1$s for update using (has_perm(%2$L,''write''));', t, res);
    execute format('create policy %1$s_delete on %1$s for delete using (has_perm(%2$L,''admin''));', t, res);
  end loop;
end $$;

-- Validação: assinar (validated_by/status) exige 'validate'
create policy validacoes_validate on validacoes_mensais for update
  using (has_perm('validacoes','write') or has_perm('validacoes','validate'));

-- Profiles: cada um lê o próprio; quem tem users:read lê todos; users:admin gere.
alter table profiles enable row level security;
create policy profiles_self_read on profiles for select using (id = auth.uid() or has_perm('users','read'));
create policy profiles_self_upd  on profiles for update using (id = auth.uid() or has_perm('users','admin'));
create policy profiles_admin_ins on profiles for insert with check (has_perm('users','admin'));
create policy profiles_admin_del on profiles for delete using (has_perm('users','admin'));

-- Tabelas de configuração RBAC: leitura para logados; escrita só users:admin
alter table departments      enable row level security;
alter table roles            enable row level security;
alter table role_permissions enable row level security;
create policy dep_read on departments      for select using (auth.uid() is not null);
create policy rol_read on roles            for select using (auth.uid() is not null);
create policy rp_read  on role_permissions for select using (auth.uid() is not null);
create policy dep_adm on departments      for all using (has_perm('users','admin')) with check (has_perm('users','admin'));
create policy rol_adm on roles            for all using (has_perm('users','admin')) with check (has_perm('users','admin'));
create policy rp_adm  on role_permissions for all using (has_perm('users','admin')) with check (has_perm('users','admin'));

-- Histórico: read-only para o app. Só users:read/admin lê o audit; cada um vê a própria activity.
alter table audit_log     enable row level security;
alter table user_activity enable row level security;
create policy audit_read    on audit_log     for select using (has_perm('users','read'));
create policy activity_self on user_activity for select using (user_id = auth.uid() or has_perm('users','read'));
create policy activity_ins  on user_activity for insert with check (user_id = auth.uid());

-- ============================================================================
-- 7 · SEED — departamentos, roles e matriz de permissões
-- ============================================================================

insert into departments (nome, descricao) values
  ('Asset',      'Gestão de ativos — dona da plataforma de forecast'),
  ('Comercial',  'Contratos, offtakers, descontos e PPAs'),
  ('Engenharia', 'P50 / PVsyst / perdas'),
  ('O&M',        'Operação, inversores, dados de geração real'),
  ('Financeiro', 'Faturamento e receita'),
  ('Diretoria',  'Gestão executiva'),
  ('TI',         'Administração do sistema');

insert into roles (nome, nivel, descricao) values
  ('admin',          100, 'Administra usuários e sistema (TI)'),
  ('asset_manager',   80, 'Gestor de Asset — valida forecast, edita tudo do domínio'),
  ('asset_analyst',   50, 'Analista de Asset — cadastra UC, sobe faturas, edita regras'),
  ('comercial',       40, 'Comercial — consulta e ajusta dados de contrato/desconto'),
  ('viewer',          10, 'Somente leitura');

-- Matriz (recurso × ação) por role
insert into role_permissions (role_id, recurso, can_read, can_write, can_validate, can_admin)
select r.id, x.recurso, x.can_read, x.can_write, x.can_validate, x.can_admin
from roles r
join (values
  -- admin: tudo
  ('admin','cadastro_uc',true,true,true,true),
  ('admin','faturas',    true,true,true,true),
  ('admin','regras',     true,true,true,true),
  ('admin','validacoes', true,true,true,true),
  ('admin','users',      true,true,true,true),
  -- asset_manager: opera o domínio inteiro + valida; não gere usuários
  ('asset_manager','cadastro_uc',true,true,false,true),
  ('asset_manager','faturas',    true,true,false,true),
  ('asset_manager','regras',     true,true,false,true),
  ('asset_manager','validacoes', true,true,true, true),
  ('asset_manager','users',      true,false,false,false),
  -- asset_analyst: cria/edita, mas não valida nem apaga
  ('asset_analyst','cadastro_uc',true,true,false,false),
  ('asset_analyst','faturas',    true,true,false,false),
  ('asset_analyst','regras',     true,true,false,false),
  ('asset_analyst','validacoes', true,true,false,false),
  ('asset_analyst','users',      false,false,false,false),
  -- comercial: lê tudo, edita só regras (desconto/PPA)
  ('comercial','cadastro_uc',true,false,false,false),
  ('comercial','faturas',    true,false,false,false),
  ('comercial','regras',     true,true,false,false),
  ('comercial','validacoes', true,false,false,false),
  ('comercial','users',      false,false,false,false),
  -- viewer: só leitura
  ('viewer','cadastro_uc',true,false,false,false),
  ('viewer','faturas',    true,false,false,false),
  ('viewer','regras',     true,false,false,false),
  ('viewer','validacoes', true,false,false,false),
  ('viewer','users',      false,false,false,false)
) as x(role_nome,recurso,can_read,can_write,can_validate,can_admin)
  on r.nome = x.role_nome;

-- Nota: o 1º usuário admin real deve ser promovido à mão após o signup:
--   update profiles set role_id=(select id from roles where nome='admin'),
--     department_id=(select id from departments where nome='TI'), is_active=true
--   where email='<seu-email>';
