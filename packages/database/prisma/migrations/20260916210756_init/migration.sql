-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'PAUSED');

-- CreateEnum
CREATE TYPE "PlanInterval" AS ENUM ('MONTHLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('INVITED', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "SystemRole" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'AGENT', 'VIEWER', 'CUSTOM');

-- CreateEnum
CREATE TYPE "PermissionScope" AS ENUM ('ALL', 'TEAM', 'OWN');

-- CreateEnum
CREATE TYPE "EmailTokenPurpose" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET', 'INVITATION', 'EMAIL_CHANGE');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'API_KEY', 'SYSTEM', 'AUTOMATION', 'SUPPORT');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'RESTORE', 'LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'PASSWORD_CHANGE', 'TWO_FACTOR_ENABLE', 'TWO_FACTOR_DISABLE', 'EXPORT', 'IMPORT', 'INVITE', 'ROLE_CHANGE', 'IMPERSONATE_START', 'IMPERSONATE_END', 'SETTINGS_CHANGE', 'SEND');

-- CreateEnum
CREATE TYPE "LifecycleStage" AS ENUM ('LEAD', 'PROSPECT', 'CUSTOMER', 'EVANGELIST', 'CHURNED', 'OTHER');

-- CreateEnum
CREATE TYPE "EntityType" AS ENUM ('CONTACT', 'COMPANY', 'DEAL', 'TASK');

-- CreateEnum
CREATE TYPE "FieldType" AS ENUM ('TEXT', 'TEXTAREA', 'NUMBER', 'CURRENCY', 'DATE', 'DATETIME', 'BOOLEAN', 'SELECT', 'MULTISELECT', 'EMAIL', 'PHONE', 'URL', 'USER');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('NOTE', 'CALL', 'EMAIL', 'WHATSAPP', 'MEETING', 'TASK', 'STAGE_CHANGE', 'FIELD_CHANGE', 'DOCUMENT', 'PAYMENT', 'AUTOMATION', 'AI', 'SYSTEM');

-- CreateEnum
CREATE TYPE "StageType" AS ENUM ('OPEN', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "DealStatus" AS ENUM ('OPEN', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('WHATSAPP_CLOUD', 'EMAIL', 'SMS', 'INSTAGRAM', 'MESSENGER', 'WEBCHAT');

-- CreateEnum
CREATE TYPE "ChannelStatus" AS ENUM ('PENDING', 'CONNECTED', 'ERROR', 'DISABLED');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'PENDING', 'RESOLVED', 'SNOOZED');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'STICKER', 'LOCATION', 'CONTACTS', 'TEMPLATE', 'INTERACTIVE', 'REACTION', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MessageDeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "AiSourceType" AS ENUM ('PDF', 'DOCX', 'TXT', 'MARKDOWN', 'URL', 'MANUAL');

-- CreateEnum
CREATE TYPE "AiSourceStatus" AS ENUM ('UPLOADED', 'PROCESSING', 'INDEXED', 'ERROR');

-- CreateEnum
CREATE TYPE "AiPurpose" AS ENUM ('CHAT', 'REPLY_SUGGESTION', 'AUTO_REPLY', 'SUMMARY', 'ANALYSIS', 'NEXT_STEP', 'DRAFT');

-- CreateEnum
CREATE TYPE "AiRole" AS ENUM ('SYSTEM', 'USER', 'ASSISTANT', 'TOOL');

-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('PENDING', 'RUNNING', 'WAITING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StepStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('QUOTE', 'PROFORMA', 'INVOICE', 'CREDIT_NOTE');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('DRAFT', 'SENT', 'VIEWED', 'ACCEPTED', 'REJECTED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOID');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'TRANSFER', 'CARD', 'CHECK', 'CRYPTO', 'OTHER');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('MEETING', 'CALL', 'FOLLOW_UP', 'DEMO', 'OTHER');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('CONFIRMED', 'TENTATIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AttendeeResponse" AS ENUM ('NEEDS_ACTION', 'ACCEPTED', 'DECLINED', 'TENTATIVE');

-- CreateEnum
CREATE TYPE "ReminderChannel" AS ENUM ('IN_APP', 'EMAIL', 'WHATSAPP', 'PUSH');

-- CreateEnum
CREATE TYPE "WidgetType" AS ENUM ('KPI', 'LINE', 'BAR', 'PIE', 'FUNNEL', 'TABLE', 'LIST', 'GAUGE');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('MESSAGE', 'MENTION', 'TASK_ASSIGNED', 'TASK_DUE', 'DEAL_ASSIGNED', 'DEAL_WON', 'DOCUMENT_PAID', 'EVENT_REMINDER', 'IMPORT_FINISHED', 'WORKFLOW_FAILED', 'CHANNEL_ERROR', 'SYSTEM');

-- CreateEnum
CREATE TYPE "FilePurpose" AS ENUM ('ATTACHMENT', 'AVATAR', 'LOGO', 'DOCUMENT_PDF', 'AI_SOURCE', 'IMPORT', 'EXPORT');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'SKIPPED', 'ERROR');

-- CreateTable
CREATE TABLE "plan" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price_monthly" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "price_yearly" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "max_users" INTEGER NOT NULL DEFAULT 3,
    "max_contacts" INTEGER NOT NULL DEFAULT 1000,
    "max_channels" INTEGER NOT NULL DEFAULT 1,
    "max_workflows" INTEGER NOT NULL DEFAULT 3,
    "max_ai_sources" INTEGER NOT NULL DEFAULT 10,
    "max_storage_mb" INTEGER NOT NULL DEFAULT 1024,
    "monthly_ai_credits" INTEGER NOT NULL DEFAULT 0,
    "monthly_messages" INTEGER NOT NULL DEFAULT 1000,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "trial_days" INTEGER NOT NULL DEFAULT 14,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_feature" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "plan_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB,

    CONSTRAINT "plan_feature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "slug" VARCHAR(63) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'TRIAL',
    "logo_url" TEXT,
    "brand_color" VARCHAR(9),
    "legal_name" VARCHAR(200),
    "tax_id" VARCHAR(40),
    "address_line" TEXT,
    "city" VARCHAR(120),
    "country" CHAR(2),
    "phone" VARCHAR(32),
    "website" TEXT,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'America/Guayaquil',
    "locale" VARCHAR(10) NOT NULL DEFAULT 'es',
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "suspended_at" TIMESTAMPTZ(6),
    "suspended_reason" TEXT,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "interval" "PlanInterval" NOT NULL DEFAULT 'MONTHLY',
    "provider_name" VARCHAR(40),
    "provider_customer_id" VARCHAR(120),
    "provider_subscription_id" VARCHAR(120),
    "current_period_start" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "current_period_end" TIMESTAMPTZ(6) NOT NULL,
    "trial_ends_at" TIMESTAMPTZ(6),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "canceled_at" TIMESTAMPTZ(6),
    "limit_overrides" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_invoice" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "subscription_id" UUID NOT NULL,
    "number" VARCHAR(40) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "status" VARCHAR(20) NOT NULL DEFAULT 'open',
    "paid_at" TIMESTAMPTZ(6),
    "due_at" TIMESTAMPTZ(6),
    "pdf_url" TEXT,
    "provider_invoice_id" VARCHAR(120),
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "period_end" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_usage" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "active_users" INTEGER NOT NULL DEFAULT 0,
    "contact_count" INTEGER NOT NULL DEFAULT 0,
    "messages_in" INTEGER NOT NULL DEFAULT 0,
    "messages_out" INTEGER NOT NULL DEFAULT 0,
    "ai_tokens_in" INTEGER NOT NULL DEFAULT 0,
    "ai_tokens_out" INTEGER NOT NULL DEFAULT 0,
    "ai_cost_usd" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "workflow_runs" INTEGER NOT NULL DEFAULT 0,
    "documents_issued" INTEGER NOT NULL DEFAULT 0,
    "storage_mb" INTEGER NOT NULL DEFAULT 0,
    "api_calls" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "tenant_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_admin" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "email" VARCHAR(255) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "totp_secret" TEXT,
    "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "recovery_codes" TEXT[],
    "last_login_at" TIMESTAMPTZ(6),
    "last_login_ip" INET,
    "disabled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "platform_admin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "email" VARCHAR(255) NOT NULL,
    "password_hash" TEXT,
    "name" VARCHAR(120) NOT NULL,
    "avatar_url" TEXT,
    "phone" VARCHAR(32),
    "locale" VARCHAR(10) NOT NULL DEFAULT 'es',
    "timezone" VARCHAR(64),
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "email_verified_at" TIMESTAMPTZ(6),
    "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "recovery_codes" TEXT[],
    "last_login_at" TIMESTAMPTZ(6),
    "last_login_ip" INET,
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'INVITED',
    "team_name" VARCHAR(80),
    "invited_by_user_id" UUID,
    "invited_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_at" TIMESTAMPTZ(6),
    "disabled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "key" "SystemRole" NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "role_id" UUID NOT NULL,
    "permission" VARCHAR(64) NOT NULL,
    "scope" "PermissionScope" NOT NULL DEFAULT 'ALL',

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_token" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "family_id" UUID NOT NULL,
    "tenant_id" UUID,
    "user_agent" TEXT,
    "ip" INET,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" VARCHAR(60),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "totp_secret" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "secret_encrypted" TEXT NOT NULL,
    "confirmed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "totp_secret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_token" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "purpose" "EmailTokenPurpose" NOT NULL,
    "payload" JSONB,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_key" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "prefix" VARCHAR(16) NOT NULL,
    "key_hash" VARCHAR(64) NOT NULL,
    "scopes" TEXT[],
    "last_used_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "actor_email" VARCHAR(255),
    "actor_type" "ActorType" NOT NULL DEFAULT 'USER',
    "action" "AuditAction" NOT NULL,
    "resource_type" VARCHAR(60) NOT NULL,
    "resource_id" UUID,
    "resource_label" VARCHAR(200),
    "changes" JSONB,
    "ip" INET,
    "user_agent" TEXT,
    "trace_id" VARCHAR(40),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "legal_name" VARCHAR(200),
    "tax_id" VARCHAR(40),
    "industry" VARCHAR(80),
    "size" VARCHAR(40),
    "website" TEXT,
    "phone" VARCHAR(32),
    "email" VARCHAR(255),
    "address_line" TEXT,
    "city" VARCHAR(120),
    "state" VARCHAR(120),
    "postal_code" VARCHAR(20),
    "country" CHAR(2),
    "custom" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "first_name" VARCHAR(80) NOT NULL,
    "last_name" VARCHAR(80),
    "full_name" VARCHAR(165) NOT NULL DEFAULT '',
    "job_title" VARCHAR(120),
    "company_id" UUID,
    "company_name" VARCHAR(200),
    "email" VARCHAR(255),
    "phone_e164" VARCHAR(20),
    "whatsapp_e164" VARCHAR(20),
    "address_line" TEXT,
    "city" VARCHAR(120),
    "state" VARCHAR(120),
    "postal_code" VARCHAR(20),
    "country" CHAR(2),
    "lifecycle_stage" "LifecycleStage" NOT NULL DEFAULT 'LEAD',
    "source" VARCHAR(80),
    "owner_id" UUID,
    "custom" JSONB NOT NULL DEFAULT '{}',
    "search_vector" tsvector,
    "last_activity_at" TIMESTAMPTZ(6),
    "last_contacted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tag" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "color" VARCHAR(9) NOT NULL DEFAULT '#6B7280',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_tag" (
    "contact_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_tag_pkey" PRIMARY KEY ("contact_id","tag_id")
);

-- CreateTable
CREATE TABLE "custom_field" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "entity" "EntityType" NOT NULL,
    "key" VARCHAR(50) NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "type" "FieldType" NOT NULL,
    "options" JSONB,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "help_text" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "show_in_list" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "custom_field_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_field_value" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "field_id" UUID NOT NULL,
    "contact_id" UUID,
    "deal_id" UUID,
    "value_text" TEXT,
    "value_number" DECIMAL(18,4),
    "value_date" TIMESTAMPTZ(6),
    "value_bool" BOOLEAN,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "custom_field_value_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "contact_id" UUID,
    "deal_id" UUID,
    "author_id" UUID,
    "mentions" UUID[],
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "type" "ActivityType" NOT NULL,
    "subject_type" VARCHAR(40) NOT NULL,
    "subject_id" UUID,
    "contact_id" UUID,
    "deal_id" UUID,
    "actor_id" UUID,
    "actor_type" "ActorType" NOT NULL DEFAULT 'USER',
    "title" VARCHAR(200) NOT NULL,
    "summary" TEXT,
    "payload" JSONB,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "pipeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline_stage" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "pipeline_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "type" "StageType" NOT NULL DEFAULT 'OPEN',
    "color" VARCHAR(9) NOT NULL DEFAULT '#6B7280',
    "probability" INTEGER NOT NULL DEFAULT 0,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 1000,
    "rotting_days" INTEGER,

    CONSTRAINT "pipeline_stage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "pipeline_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "contact_id" UUID,
    "company_id" UUID,
    "owner_id" UUID,
    "value" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "probability" INTEGER NOT NULL DEFAULT 0,
    "status" "DealStatus" NOT NULL DEFAULT 'OPEN',
    "expected_close_at" DATE,
    "closed_at" TIMESTAMPTZ(6),
    "lost_reason_id" UUID,
    "lost_reason_note" TEXT,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 1000,
    "source" VARCHAR(80),
    "custom" JSONB NOT NULL DEFAULT '{}',
    "items_total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "stage_entered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "deal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_stage_history" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "from_stage_id" UUID,
    "moved_by_user_id" UUID,
    "moved_by_type" "ActorType" NOT NULL DEFAULT 'USER',
    "entered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exited_at" TIMESTAMPTZ(6),
    "duration_seconds" INTEGER,

    CONSTRAINT "deal_stage_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "sku" VARCHAR(60),
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "unit_price" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "unit" VARCHAR(30) NOT NULL DEFAULT 'unidad',
    "tax_rate_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_item" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "product_id" UUID,
    "name" VARCHAR(200) NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 1,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "discount" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "deal_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lost_reason" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "lost_reason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "type" "ChannelType" NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "status" "ChannelStatus" NOT NULL DEFAULT 'PENDING',
    "external_id" VARCHAR(120),
    "display_id" VARCHAR(40),
    "credentials_encrypted" TEXT,
    "webhook_secret_encrypted" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "last_error_at" TIMESTAMPTZ(6),
    "last_error_message" TEXT,
    "connected_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_identity" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "type" "ChannelType" NOT NULL,
    "value" VARCHAR(120) NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
    "assignee_id" UUID,
    "window_expires_at" TIMESTAMPTZ(6),
    "last_message_at" TIMESTAMPTZ(6),
    "last_message_preview" VARCHAR(200),
    "last_message_direction" "MessageDirection",
    "unread_count" INTEGER NOT NULL DEFAULT 0,
    "ai_enabled" BOOLEAN NOT NULL DEFAULT true,
    "snoozed_until" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "type" "MessageType" NOT NULL DEFAULT 'TEXT',
    "body" TEXT,
    "external_id" VARCHAR(160),
    "status" "MessageDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "status_updated_at" TIMESTAMPTZ(6),
    "error_code" VARCHAR(40),
    "error_message" TEXT,
    "sender_user_id" UUID,
    "sender_type" "ActorType" NOT NULL DEFAULT 'USER',
    "is_internal" BOOLEAN NOT NULL DEFAULT false,
    "template_id" UUID,
    "template_params" JSONB,
    "reply_to_external_id" VARCHAR(160),
    "raw_payload" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_media" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "file_id" UUID,
    "external_media_id" VARCHAR(160),
    "mime_type" VARCHAR(120),
    "filename" VARCHAR(255),
    "size_bytes" INTEGER,
    "caption" TEXT,
    "duration_seconds" INTEGER,
    "downloaded_at" TIMESTAMPTZ(6),
    "download_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wa_template" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "language" VARCHAR(10) NOT NULL DEFAULT 'es',
    "category" VARCHAR(30) NOT NULL DEFAULT 'UTILITY',
    "status" "TemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "external_id" VARCHAR(120),
    "rejected_reason" TEXT,
    "components" JSONB NOT NULL,
    "variables" TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "wa_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_event" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "provider" VARCHAR(40) NOT NULL,
    "event_id" VARCHAR(200) NOT NULL,
    "event_type" VARCHAR(80),
    "tenant_id" UUID,
    "channel_id" UUID,
    "payload" JSONB NOT NULL,
    "signature" TEXT,
    "status" "WebhookStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "processed_at" TIMESTAMPTZ(6),
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_source" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "type" "AiSourceType" NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "status" "AiSourceStatus" NOT NULL DEFAULT 'UPLOADED',
    "file_id" UUID,
    "url" TEXT,
    "extracted_text" TEXT,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "token_count" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "indexed_at" TIMESTAMPTZ(6),
    "uploaded_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "ai_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_chunk" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "embedding" vector(1536),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_thread" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "title" VARCHAR(200),
    "conversation_id" UUID,
    "user_id" UUID,
    "purpose" "AiPurpose" NOT NULL DEFAULT 'CHAT',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ai_thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_message" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "role" "AiRole" NOT NULL,
    "content" TEXT NOT NULL,
    "citations" JSONB,
    "model" VARCHAR(60),
    "tokens_in" INTEGER NOT NULL DEFAULT 0,
    "tokens_out" INTEGER NOT NULL DEFAULT 0,
    "latency_ms" INTEGER,
    "finish_reason" VARCHAR(30),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "purpose" "AiPurpose" NOT NULL,
    "model" VARCHAR(60) NOT NULL,
    "tokens_in" INTEGER NOT NULL DEFAULT 0,
    "tokens_out" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_setting" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "system_prompt" TEXT,
    "assistant_name" VARCHAR(60) NOT NULL DEFAULT 'Asistente',
    "tone" VARCHAR(40) NOT NULL DEFAULT 'profesional',
    "auto_reply" BOOLEAN NOT NULL DEFAULT false,
    "auto_reply_skip_assigned" BOOLEAN NOT NULL DEFAULT true,
    "auto_reply_schedule" JSONB,
    "chat_model" VARCHAR(60) NOT NULL DEFAULT 'gpt-4o-mini',
    "embedding_model" VARCHAR(60) NOT NULL DEFAULT 'text-embedding-3-small',
    "temperature" DECIMAL(3,2) NOT NULL DEFAULT 0.3,
    "max_context_chunks" INTEGER NOT NULL DEFAULT 6,
    "monthly_budget_usd" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "min_similarity" DECIMAL(4,3) NOT NULL DEFAULT 0.25,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ai_setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'DRAFT',
    "trigger_type" VARCHAR(60) NOT NULL,
    "trigger_config" JSONB NOT NULL DEFAULT '{}',
    "active_version_id" UUID,
    "allow_reenrollment" BOOLEAN NOT NULL DEFAULT false,
    "total_runs" INTEGER NOT NULL DEFAULT 0,
    "failed_runs" INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_version" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "graph" JSONB NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "published_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_run" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'PENDING',
    "trigger_event" VARCHAR(60) NOT NULL,
    "subject_type" VARCHAR(40),
    "subject_id" UUID,
    "context" JSONB NOT NULL DEFAULT '{}',
    "current_node_id" VARCHAR(60),
    "resume_at" TIMESTAMPTZ(6),
    "error_message" TEXT,
    "error_node_id" VARCHAR(60),
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "workflow_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_run_step" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "node_id" VARCHAR(60) NOT NULL,
    "node_type" VARCHAR(60) NOT NULL,
    "status" "StepStatus" NOT NULL DEFAULT 'PENDING',
    "input" JSONB,
    "output" JSONB,
    "branch_taken" VARCHAR(60),
    "skip_reason" TEXT,
    "error_message" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "duration_ms" INTEGER,

    CONSTRAINT "workflow_run_step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_enrollment" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "run_id" UUID,
    "enrolled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exited_at" TIMESTAMPTZ(6),
    "exit_reason" VARCHAR(60),

    CONSTRAINT "workflow_enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "number" VARCHAR(40) NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "contact_id" UUID,
    "company_id" UUID,
    "deal_id" UUID,
    "bill_to_name" VARCHAR(200) NOT NULL,
    "bill_to_tax_id" VARCHAR(40),
    "bill_to_email" VARCHAR(255),
    "bill_to_address" TEXT,
    "bill_to_city" VARCHAR(120),
    "bill_to_country" CHAR(2),
    "issue_date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_date" DATE,
    "valid_until" DATE,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "exchange_rate" DECIMAL(12,6) NOT NULL DEFAULT 1,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discount_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "paid_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "terms" TEXT,
    "template_id" UUID,
    "pdf_file_id" UUID,
    "sent_at" TIMESTAMPTZ(6),
    "viewed_at" TIMESTAMPTZ(6),
    "accepted_at" TIMESTAMPTZ(6),
    "paid_at" TIMESTAMPTZ(6),
    "voided_at" TIMESTAMPTZ(6),
    "converted_from_id" UUID,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_item" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "product_id" UUID,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit" VARCHAR(30) NOT NULL DEFAULT 'unidad',
    "unit_price" DECIMAL(14,2) NOT NULL,
    "discount_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "tax_rate_id" UUID,
    "tax_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "document_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "method" "PaymentMethod" NOT NULL DEFAULT 'TRANSFER',
    "reference" VARCHAR(120),
    "notes" TEXT,
    "paid_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rate" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "percent" DECIMAL(5,2) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_rate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "number_sequence" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "series" VARCHAR(10) NOT NULL DEFAULT '001',
    "year" INTEGER NOT NULL,
    "prefix" VARCHAR(20) NOT NULL DEFAULT '',
    "padding" INTEGER NOT NULL DEFAULT 5,
    "current" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "number_sequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doc_template" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "design" JSONB NOT NULL DEFAULT '{}',
    "header_note" TEXT,
    "footer_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "doc_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "priority" "TaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "due_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "assignee_id" UUID,
    "creator_id" UUID,
    "contact_id" UUID,
    "deal_id" UUID,
    "created_by_type" "ActorType" NOT NULL DEFAULT 'USER',
    "workflow_run_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "location" VARCHAR(255),
    "meeting_url" TEXT,
    "type" "EventType" NOT NULL DEFAULT 'MEETING',
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'America/Guayaquil',
    "all_day" BOOLEAN NOT NULL DEFAULT false,
    "recurrence_rule" VARCHAR(255),
    "recurrence_exceptions" TIMESTAMPTZ(6)[],
    "recurring_event_id" UUID,
    "organizer_id" UUID,
    "contact_id" UUID,
    "deal_id" UUID,
    "status" "EventStatus" NOT NULL DEFAULT 'CONFIRMED',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_attendee" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "user_id" UUID,
    "contact_id" UUID,
    "email" VARCHAR(255),
    "name" VARCHAR(120),
    "response" "AttendeeResponse" NOT NULL DEFAULT 'NEEDS_ACTION',
    "is_organizer" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "event_attendee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminder" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "task_id" UUID,
    "event_id" UUID,
    "user_id" UUID NOT NULL,
    "remind_at" TIMESTAMPTZ(6) NOT NULL,
    "channel" "ReminderChannel" NOT NULL DEFAULT 'IN_APP',
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,

    CONSTRAINT "availability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "owner_id" UUID,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "preset" VARCHAR(40),
    "layout" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dashboard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "widget" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "dashboard_id" UUID NOT NULL,
    "type" "WidgetType" NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "query" JSONB NOT NULL,
    "display" JSONB NOT NULL DEFAULT '{}',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "widget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_view" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "entity" "EntityType" NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "owner_id" UUID,
    "is_shared" BOOLEAN NOT NULL DEFAULT false,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "columns" JSONB NOT NULL DEFAULT '[]',
    "sort" JSONB NOT NULL DEFAULT '{}',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "saved_view_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "resource_type" VARCHAR(40),
    "resource_id" UUID,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "storage_key" VARCHAR(400) NOT NULL,
    "bucket" VARCHAR(60) NOT NULL DEFAULT 'nexo',
    "original_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(120) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "checksum" VARCHAR(64),
    "purpose" "FilePurpose" NOT NULL DEFAULT 'ATTACHMENT',
    "uploaded_by_id" UUID,
    "scan_status" "ScanStatus" NOT NULL DEFAULT 'PENDING',
    "scan_result" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "file_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_webhook" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT[],
    "secret_encrypted" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_delivery_at" TIMESTAMPTZ(6),
    "last_status_code" INTEGER,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "disabled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "outbound_webhook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plan_code_key" ON "plan"("code");

-- CreateIndex
CREATE INDEX "plan_is_public_sort_order_idx" ON "plan"("is_public", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "plan_feature_plan_id_key_key" ON "plan_feature"("plan_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_slug_key" ON "tenant"("slug");

-- CreateIndex
CREATE INDEX "tenant_status_idx" ON "tenant"("status");

-- CreateIndex
CREATE INDEX "tenant_deleted_at_idx" ON "tenant"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_tenant_id_key" ON "subscription"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_provider_subscription_id_key" ON "subscription"("provider_subscription_id");

-- CreateIndex
CREATE INDEX "subscription_status_current_period_end_idx" ON "subscription"("status", "current_period_end");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_invoice_number_key" ON "subscription_invoice"("number");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_invoice_provider_invoice_id_key" ON "subscription_invoice"("provider_invoice_id");

-- CreateIndex
CREATE INDEX "subscription_invoice_subscription_id_created_at_idx" ON "subscription_invoice"("subscription_id", "created_at");

-- CreateIndex
CREATE INDEX "subscription_invoice_status_due_at_idx" ON "subscription_invoice"("status", "due_at");

-- CreateIndex
CREATE INDEX "tenant_usage_day_idx" ON "tenant_usage"("day");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_usage_tenant_id_day_key" ON "tenant_usage"("tenant_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "platform_admin_email_key" ON "platform_admin"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "user_status_idx" ON "user"("status");

-- CreateIndex
CREATE INDEX "user_deleted_at_idx" ON "user"("deleted_at");

-- CreateIndex
CREATE INDEX "membership_tenant_id_status_idx" ON "membership"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "membership_user_id_status_idx" ON "membership"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "membership_tenant_id_user_id_key" ON "membership"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "role_tenant_id_idx" ON "role"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_tenant_id_name_key" ON "role"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "role_permission_role_id_idx" ON "role_permission"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_permission_role_id_permission_key" ON "role_permission"("role_id", "permission");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_token_hash_key" ON "refresh_token"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_token_user_id_revoked_at_idx" ON "refresh_token"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "refresh_token_family_id_idx" ON "refresh_token"("family_id");

-- CreateIndex
CREATE INDEX "refresh_token_expires_at_idx" ON "refresh_token"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "totp_secret_user_id_key" ON "totp_secret"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_token_token_hash_key" ON "email_token"("token_hash");

-- CreateIndex
CREATE INDEX "email_token_user_id_purpose_idx" ON "email_token"("user_id", "purpose");

-- CreateIndex
CREATE INDEX "email_token_expires_at_idx" ON "email_token"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_key_prefix_key" ON "api_key"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "api_key_key_hash_key" ON "api_key"("key_hash");

-- CreateIndex
CREATE INDEX "api_key_tenant_id_revoked_at_idx" ON "api_key"("tenant_id", "revoked_at");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_created_at_idx" ON "audit_log"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_resource_type_resource_id_idx" ON "audit_log"("tenant_id", "resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_actor_user_id_created_at_idx" ON "audit_log"("tenant_id", "actor_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "company_tenant_id_deleted_at_idx" ON "company"("tenant_id", "deleted_at");

-- CreateIndex
CREATE INDEX "company_tenant_id_name_idx" ON "company"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "contact_tenant_id_deleted_at_created_at_idx" ON "contact"("tenant_id", "deleted_at", "created_at" DESC);

-- CreateIndex
CREATE INDEX "contact_tenant_id_owner_id_idx" ON "contact"("tenant_id", "owner_id");

-- CreateIndex
CREATE INDEX "contact_tenant_id_company_id_idx" ON "contact"("tenant_id", "company_id");

-- CreateIndex
CREATE INDEX "contact_tenant_id_lifecycle_stage_idx" ON "contact"("tenant_id", "lifecycle_stage");

-- CreateIndex
CREATE INDEX "contact_tenant_id_last_activity_at_idx" ON "contact"("tenant_id", "last_activity_at" DESC);

-- CreateIndex
CREATE INDEX "tag_tenant_id_idx" ON "tag"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tag_tenant_id_name_key" ON "tag"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "contact_tag_tag_id_idx" ON "contact_tag"("tag_id");

-- CreateIndex
CREATE INDEX "contact_tag_tenant_id_idx" ON "contact_tag"("tenant_id");

-- CreateIndex
CREATE INDEX "custom_field_tenant_id_entity_sort_order_idx" ON "custom_field"("tenant_id", "entity", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_tenant_id_entity_key_key" ON "custom_field"("tenant_id", "entity", "key");

-- CreateIndex
CREATE INDEX "custom_field_value_tenant_id_field_id_value_text_idx" ON "custom_field_value"("tenant_id", "field_id", "value_text");

-- CreateIndex
CREATE INDEX "custom_field_value_tenant_id_field_id_value_number_idx" ON "custom_field_value"("tenant_id", "field_id", "value_number");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_value_field_id_contact_id_key" ON "custom_field_value"("field_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_value_field_id_deal_id_key" ON "custom_field_value"("field_id", "deal_id");

-- CreateIndex
CREATE INDEX "note_tenant_id_contact_id_created_at_idx" ON "note"("tenant_id", "contact_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "note_tenant_id_deal_id_created_at_idx" ON "note"("tenant_id", "deal_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "activity_tenant_id_contact_id_occurred_at_idx" ON "activity"("tenant_id", "contact_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "activity_tenant_id_deal_id_occurred_at_idx" ON "activity"("tenant_id", "deal_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "activity_tenant_id_type_occurred_at_idx" ON "activity"("tenant_id", "type", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "pipeline_tenant_id_archived_at_idx" ON "pipeline"("tenant_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "pipeline_tenant_id_name_key" ON "pipeline"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "pipeline_stage_tenant_id_pipeline_id_position_idx" ON "pipeline_stage"("tenant_id", "pipeline_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "pipeline_stage_pipeline_id_name_key" ON "pipeline_stage"("pipeline_id", "name");

-- CreateIndex
CREATE INDEX "deal_tenant_id_pipeline_id_stage_id_position_idx" ON "deal"("tenant_id", "pipeline_id", "stage_id", "position");

-- CreateIndex
CREATE INDEX "deal_tenant_id_owner_id_status_idx" ON "deal"("tenant_id", "owner_id", "status");

-- CreateIndex
CREATE INDEX "deal_tenant_id_status_expected_close_at_idx" ON "deal"("tenant_id", "status", "expected_close_at");

-- CreateIndex
CREATE INDEX "deal_tenant_id_contact_id_idx" ON "deal"("tenant_id", "contact_id");

-- CreateIndex
CREATE INDEX "deal_tenant_id_deleted_at_idx" ON "deal"("tenant_id", "deleted_at");

-- CreateIndex
CREATE INDEX "deal_stage_history_tenant_id_deal_id_entered_at_idx" ON "deal_stage_history"("tenant_id", "deal_id", "entered_at");

-- CreateIndex
CREATE INDEX "deal_stage_history_tenant_id_stage_id_entered_at_idx" ON "deal_stage_history"("tenant_id", "stage_id", "entered_at");

-- CreateIndex
CREATE INDEX "product_tenant_id_active_name_idx" ON "product"("tenant_id", "active", "name");

-- CreateIndex
CREATE UNIQUE INDEX "product_tenant_id_sku_key" ON "product"("tenant_id", "sku");

-- CreateIndex
CREATE INDEX "deal_item_tenant_id_deal_id_idx" ON "deal_item"("tenant_id", "deal_id");

-- CreateIndex
CREATE INDEX "lost_reason_tenant_id_active_idx" ON "lost_reason"("tenant_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "lost_reason_tenant_id_name_key" ON "lost_reason"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "channel_tenant_id_type_status_idx" ON "channel"("tenant_id", "type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "channel_provider_identity_key" ON "channel"("type", "external_id");

-- CreateIndex
CREATE INDEX "contact_identity_tenant_id_contact_id_idx" ON "contact_identity"("tenant_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_identity_tenant_id_type_value_key" ON "contact_identity"("tenant_id", "type", "value");

-- CreateIndex
CREATE INDEX "conversation_tenant_id_status_last_message_at_idx" ON "conversation"("tenant_id", "status", "last_message_at" DESC);

-- CreateIndex
CREATE INDEX "conversation_tenant_id_assignee_id_status_idx" ON "conversation"("tenant_id", "assignee_id", "status");

-- CreateIndex
CREATE INDEX "conversation_tenant_id_contact_id_idx" ON "conversation"("tenant_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_channel_id_contact_id_key" ON "conversation"("channel_id", "contact_id");

-- CreateIndex
CREATE INDEX "message_tenant_id_conversation_id_created_at_idx" ON "message"("tenant_id", "conversation_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "message_tenant_id_status_created_at_idx" ON "message"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "message_conversation_id_created_at_idx" ON "message"("conversation_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "message_channel_external_key" ON "message"("channel_id", "external_id");

-- CreateIndex
CREATE INDEX "message_media_tenant_id_message_id_idx" ON "message_media"("tenant_id", "message_id");

-- CreateIndex
CREATE INDEX "wa_template_tenant_id_status_idx" ON "wa_template"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "wa_template_channel_id_name_language_key" ON "wa_template"("channel_id", "name", "language");

-- CreateIndex
CREATE INDEX "webhook_event_status_received_at_idx" ON "webhook_event"("status", "received_at");

-- CreateIndex
CREATE INDEX "webhook_event_tenant_id_received_at_idx" ON "webhook_event"("tenant_id", "received_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "webhook_event_provider_event_id_key" ON "webhook_event"("provider", "event_id");

-- CreateIndex
CREATE INDEX "ai_source_tenant_id_status_idx" ON "ai_source"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "ai_source_tenant_id_deleted_at_created_at_idx" ON "ai_source"("tenant_id", "deleted_at", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ai_chunk_tenant_id_source_id_idx" ON "ai_chunk"("tenant_id", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_chunk_source_id_chunk_index_key" ON "ai_chunk"("source_id", "chunk_index");

-- CreateIndex
CREATE INDEX "ai_thread_tenant_id_user_id_updated_at_idx" ON "ai_thread"("tenant_id", "user_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "ai_thread_tenant_id_conversation_id_idx" ON "ai_thread"("tenant_id", "conversation_id");

-- CreateIndex
CREATE INDEX "ai_message_tenant_id_thread_id_created_at_idx" ON "ai_message"("tenant_id", "thread_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_usage_tenant_id_created_at_idx" ON "ai_usage"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ai_usage_tenant_id_purpose_created_at_idx" ON "ai_usage"("tenant_id", "purpose", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_setting_tenant_id_key" ON "ai_setting"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_active_version_id_key" ON "workflow"("active_version_id");

-- CreateIndex
CREATE INDEX "workflow_tenant_id_status_idx" ON "workflow"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "workflow_tenant_id_trigger_type_status_idx" ON "workflow"("tenant_id", "trigger_type", "status");

-- CreateIndex
CREATE INDEX "workflow_version_tenant_id_workflow_id_idx" ON "workflow_version"("tenant_id", "workflow_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_version_workflow_id_version_key" ON "workflow_version"("workflow_id", "version");

-- CreateIndex
CREATE INDEX "workflow_run_tenant_id_workflow_id_started_at_idx" ON "workflow_run"("tenant_id", "workflow_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "workflow_run_status_resume_at_idx" ON "workflow_run"("status", "resume_at");

-- CreateIndex
CREATE INDEX "workflow_run_tenant_id_subject_type_subject_id_idx" ON "workflow_run"("tenant_id", "subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "workflow_run_step_tenant_id_run_id_started_at_idx" ON "workflow_run_step"("tenant_id", "run_id", "started_at");

-- CreateIndex
CREATE INDEX "workflow_enrollment_tenant_id_workflow_id_contact_id_idx" ON "workflow_enrollment"("tenant_id", "workflow_id", "contact_id");

-- CreateIndex
CREATE INDEX "workflow_enrollment_tenant_id_contact_id_idx" ON "workflow_enrollment"("tenant_id", "contact_id");

-- CreateIndex
CREATE INDEX "document_tenant_id_kind_status_issue_date_idx" ON "document"("tenant_id", "kind", "status", "issue_date" DESC);

-- CreateIndex
CREATE INDEX "document_tenant_id_contact_id_idx" ON "document"("tenant_id", "contact_id");

-- CreateIndex
CREATE INDEX "document_tenant_id_deal_id_idx" ON "document"("tenant_id", "deal_id");

-- CreateIndex
CREATE INDEX "document_tenant_id_status_due_date_idx" ON "document"("tenant_id", "status", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "document_tenant_id_kind_number_key" ON "document"("tenant_id", "kind", "number");

-- CreateIndex
CREATE INDEX "document_item_tenant_id_document_id_sort_order_idx" ON "document_item"("tenant_id", "document_id", "sort_order");

-- CreateIndex
CREATE INDEX "payment_tenant_id_document_id_idx" ON "payment"("tenant_id", "document_id");

-- CreateIndex
CREATE INDEX "payment_tenant_id_paid_at_idx" ON "payment"("tenant_id", "paid_at" DESC);

-- CreateIndex
CREATE INDEX "tax_rate_tenant_id_active_idx" ON "tax_rate"("tenant_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rate_tenant_id_name_key" ON "tax_rate"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "number_sequence_tenant_id_kind_series_year_key" ON "number_sequence"("tenant_id", "kind", "series", "year");

-- CreateIndex
CREATE UNIQUE INDEX "doc_template_tenant_id_kind_name_key" ON "doc_template"("tenant_id", "kind", "name");

-- CreateIndex
CREATE INDEX "task_tenant_id_assignee_id_status_due_at_idx" ON "task"("tenant_id", "assignee_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "task_tenant_id_status_due_at_idx" ON "task"("tenant_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "task_tenant_id_contact_id_idx" ON "task"("tenant_id", "contact_id");

-- CreateIndex
CREATE INDEX "task_tenant_id_deal_id_idx" ON "task"("tenant_id", "deal_id");

-- CreateIndex
CREATE INDEX "event_tenant_id_starts_at_idx" ON "event"("tenant_id", "starts_at");

-- CreateIndex
CREATE INDEX "event_tenant_id_organizer_id_starts_at_idx" ON "event"("tenant_id", "organizer_id", "starts_at");

-- CreateIndex
CREATE INDEX "event_tenant_id_contact_id_idx" ON "event"("tenant_id", "contact_id");

-- CreateIndex
CREATE INDEX "event_attendee_tenant_id_event_id_idx" ON "event_attendee"("tenant_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_attendee_event_id_email_key" ON "event_attendee"("event_id", "email");

-- CreateIndex
CREATE INDEX "reminder_remind_at_sent_at_idx" ON "reminder"("remind_at", "sent_at");

-- CreateIndex
CREATE INDEX "reminder_tenant_id_user_id_idx" ON "reminder"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "availability_tenant_id_user_id_idx" ON "availability"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "availability_tenant_id_user_id_weekday_start_minute_key" ON "availability"("tenant_id", "user_id", "weekday", "start_minute");

-- CreateIndex
CREATE INDEX "dashboard_tenant_id_owner_id_idx" ON "dashboard"("tenant_id", "owner_id");

-- CreateIndex
CREATE INDEX "widget_tenant_id_dashboard_id_sort_order_idx" ON "widget"("tenant_id", "dashboard_id", "sort_order");

-- CreateIndex
CREATE INDEX "saved_view_tenant_id_entity_idx" ON "saved_view"("tenant_id", "entity");

-- CreateIndex
CREATE UNIQUE INDEX "saved_view_tenant_id_entity_owner_id_name_key" ON "saved_view"("tenant_id", "entity", "owner_id", "name");

-- CreateIndex
CREATE INDEX "notification_tenant_id_user_id_read_at_created_at_idx" ON "notification"("tenant_id", "user_id", "read_at", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "file_storage_key_key" ON "file"("storage_key");

-- CreateIndex
CREATE INDEX "file_tenant_id_purpose_created_at_idx" ON "file"("tenant_id", "purpose", "created_at" DESC);

-- CreateIndex
CREATE INDEX "file_tenant_id_deleted_at_idx" ON "file"("tenant_id", "deleted_at");

-- CreateIndex
CREATE INDEX "outbound_webhook_tenant_id_active_idx" ON "outbound_webhook"("tenant_id", "active");

-- AddForeignKey
ALTER TABLE "plan_feature" ADD CONSTRAINT "plan_feature_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_invoice" ADD CONSTRAINT "subscription_invoice_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_usage" ADD CONSTRAINT "tenant_usage_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "totp_secret" ADD CONSTRAINT "totp_secret_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_token" ADD CONSTRAINT "email_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company" ADD CONSTRAINT "company_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact" ADD CONSTRAINT "contact_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact" ADD CONSTRAINT "contact_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact" ADD CONSTRAINT "contact_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag" ADD CONSTRAINT "tag_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_tag" ADD CONSTRAINT "contact_tag_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_tag" ADD CONSTRAINT "contact_tag_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field" ADD CONSTRAINT "custom_field_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_value" ADD CONSTRAINT "custom_field_value_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "custom_field"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_value" ADD CONSTRAINT "custom_field_value_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_value" ADD CONSTRAINT "custom_field_value_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note" ADD CONSTRAINT "note_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note" ADD CONSTRAINT "note_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note" ADD CONSTRAINT "note_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note" ADD CONSTRAINT "note_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity" ADD CONSTRAINT "activity_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity" ADD CONSTRAINT "activity_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity" ADD CONSTRAINT "activity_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity" ADD CONSTRAINT "activity_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline" ADD CONSTRAINT "pipeline_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_stage" ADD CONSTRAINT "pipeline_stage_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal" ADD CONSTRAINT "deal_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal" ADD CONSTRAINT "deal_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "pipeline"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal" ADD CONSTRAINT "deal_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "pipeline_stage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal" ADD CONSTRAINT "deal_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal" ADD CONSTRAINT "deal_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal" ADD CONSTRAINT "deal_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal" ADD CONSTRAINT "deal_lost_reason_id_fkey" FOREIGN KEY ("lost_reason_id") REFERENCES "lost_reason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_stage_history" ADD CONSTRAINT "deal_stage_history_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_stage_history" ADD CONSTRAINT "deal_stage_history_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "pipeline_stage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_tax_rate_id_fkey" FOREIGN KEY ("tax_rate_id") REFERENCES "tax_rate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_item" ADD CONSTRAINT "deal_item_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_item" ADD CONSTRAINT "deal_item_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lost_reason" ADD CONSTRAINT "lost_reason_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel" ADD CONSTRAINT "channel_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_identity" ADD CONSTRAINT "contact_identity_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "wa_template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_media" ADD CONSTRAINT "message_media_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_media" ADD CONSTRAINT "message_media_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wa_template" ADD CONSTRAINT "wa_template_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wa_template" ADD CONSTRAINT "wa_template_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_source" ADD CONSTRAINT "ai_source_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_source" ADD CONSTRAINT "ai_source_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_chunk" ADD CONSTRAINT "ai_chunk_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "ai_source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_thread" ADD CONSTRAINT "ai_thread_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_thread" ADD CONSTRAINT "ai_thread_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_thread" ADD CONSTRAINT "ai_thread_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_message" ADD CONSTRAINT "ai_message_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "ai_thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_setting" ADD CONSTRAINT "ai_setting_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow" ADD CONSTRAINT "workflow_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_version" ADD CONSTRAINT "workflow_version_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "workflow_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_run_step" ADD CONSTRAINT "workflow_run_step_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_enrollment" ADD CONSTRAINT "workflow_enrollment_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_enrollment" ADD CONSTRAINT "workflow_enrollment_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "doc_template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_pdf_file_id_fkey" FOREIGN KEY ("pdf_file_id") REFERENCES "file"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_item" ADD CONSTRAINT "document_item_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_item" ADD CONSTRAINT "document_item_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_item" ADD CONSTRAINT "document_item_tax_rate_id_fkey" FOREIGN KEY ("tax_rate_id") REFERENCES "tax_rate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rate" ADD CONSTRAINT "tax_rate_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "number_sequence" ADD CONSTRAINT "number_sequence_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doc_template" ADD CONSTRAINT "doc_template_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event" ADD CONSTRAINT "event_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event" ADD CONSTRAINT "event_organizer_id_fkey" FOREIGN KEY ("organizer_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event" ADD CONSTRAINT "event_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event" ADD CONSTRAINT "event_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_attendee" ADD CONSTRAINT "event_attendee_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder" ADD CONSTRAINT "reminder_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder" ADD CONSTRAINT "reminder_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability" ADD CONSTRAINT "availability_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard" ADD CONSTRAINT "dashboard_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget" ADD CONSTRAINT "widget_dashboard_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "dashboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_view" ADD CONSTRAINT "saved_view_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file" ADD CONSTRAINT "file_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file" ADD CONSTRAINT "file_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_webhook" ADD CONSTRAINT "outbound_webhook_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
