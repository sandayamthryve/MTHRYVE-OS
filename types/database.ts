// Generated from the live Supabase project (otepdjhrawtqkzclaxbk) via
//   supabase gen types typescript --project-id otepdjhrawtqkzclaxbk
// Regenerate after every schema migration — do not hand-edit table shapes.
// The alias exports at the bottom are the only intentional additions.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      metric_catalog: {
        Row: {
          api_field: string | null
          api_source: string | null
          category: string | null
          created_at: string
          department: string
          direction: string
          formula: string | null
          id: string
          is_active: boolean
          label: string
          lane: string
          metric_key: string
          org_id: string
          sort_order: number
          unit: string | null
        }
        Insert: {
          api_field?: string | null
          api_source?: string | null
          category?: string | null
          created_at?: string
          department: string
          direction?: string
          formula?: string | null
          id?: string
          is_active?: boolean
          label: string
          lane: string
          metric_key: string
          org_id?: string
          sort_order?: number
          unit?: string | null
        }
        Update: {
          api_field?: string | null
          api_source?: string | null
          category?: string | null
          created_at?: string
          department?: string
          direction?: string
          formula?: string | null
          id?: string
          is_active?: boolean
          label?: string
          lane?: string
          metric_key?: string
          org_id?: string
          sort_order?: number
          unit?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "metric_catalog_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      metric_entries: {
        Row: {
          api_value: number | null
          approved_at: string | null
          approved_by: string | null
          brand_id: string | null
          created_at: string
          department: string
          entered_by: string | null
          id: string
          manual_value: number | null
          metric_key: string
          note: string | null
          org_id: string
          origin: string
          period_end: string
          period_start: string
          updated_at: string
          validation_status: string
          variance_pct: number | null
        }
        Insert: {
          api_value?: number | null
          approved_at?: string | null
          approved_by?: string | null
          brand_id?: string | null
          created_at?: string
          department: string
          entered_by?: string | null
          id?: string
          manual_value?: number | null
          metric_key: string
          note?: string | null
          org_id?: string
          origin?: string
          period_end: string
          period_start: string
          updated_at?: string
          validation_status?: string
          variance_pct?: number | null
        }
        Update: {
          api_value?: number | null
          approved_at?: string | null
          approved_by?: string | null
          brand_id?: string | null
          created_at?: string
          department?: string
          entered_by?: string | null
          id?: string
          manual_value?: number | null
          metric_key?: string
          note?: string | null
          org_id?: string
          origin?: string
          period_end?: string
          period_start?: string
          updated_at?: string
          validation_status?: string
          variance_pct?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "metric_entries_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "brands"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "metric_entries_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      metric_targets: {
        Row: {
          amber_min: number | null
          band_high: number | null
          band_low: number | null
          created_at: string
          created_by: string | null
          department_id: string | null
          direction: string
          green_min: number | null
          id: string
          metric: string
          notes: string | null
          org_id: string
          period: string
          scope: string
          target_value: number | null
          updated_at: string
        }
        Insert: {
          amber_min?: number | null
          band_high?: number | null
          band_low?: number | null
          created_at?: string
          created_by?: string | null
          department_id?: string | null
          direction?: string
          green_min?: number | null
          id?: string
          metric: string
          notes?: string | null
          org_id: string
          period: string
          scope?: string
          target_value?: number | null
          updated_at?: string
        }
        Update: {
          amber_min?: number | null
          band_high?: number | null
          band_low?: number | null
          created_at?: string
          created_by?: string | null
          department_id?: string | null
          direction?: string
          green_min?: number | null
          id?: string
          metric?: string
          notes?: string | null
          org_id?: string
          period?: string
          scope?: string
          target_value?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "metric_targets_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "metric_targets_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "metric_targets_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "v_department_scorecard"
            referencedColumns: ["department_id"]
          },
          {
            foreignKeyName: "metric_targets_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_conversations: {
        Row: {
          created_at: string
          id: string
          org_id: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          org_id: string
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          org_id?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_conversations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_conversations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_messages: {
        Row: {
          content: string
          conversation_id: string
          created_at: string
          id: string
          role: string
        }
        Insert: {
          content: string
          conversation_id: string
          created_at?: string
          id?: string
          role: string
        }
        Update: {
          content?: string
          conversation_id?: string
          created_at?: string
          id?: string
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "ai_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      approval_requests: {
        Row: {
          action_type: string
          created_at: string
          id: string
          org_id: string
          payload: Json
          requested_by: string | null
          requested_by_agent: boolean
          review_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          risk_tier: Database["public"]["Enums"]["risk_tier"]
          status: Database["public"]["Enums"]["approval_status"]
          title: string
          updated_at: string
        }
        Insert: {
          action_type: string
          created_at?: string
          id?: string
          org_id: string
          payload?: Json
          requested_by?: string | null
          requested_by_agent?: boolean
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          risk_tier?: Database["public"]["Enums"]["risk_tier"]
          status?: Database["public"]["Enums"]["approval_status"]
          title: string
          updated_at?: string
        }
        Update: {
          action_type?: string
          created_at?: string
          id?: string
          org_id?: string
          payload?: Json
          requested_by?: string | null
          requested_by_agent?: boolean
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          risk_tier?: Database["public"]["Enums"]["risk_tier"]
          status?: Database["public"]["Enums"]["approval_status"]
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "approval_requests_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approval_requests_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approval_requests_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          diff: Json | null
          id: string
          org_id: string
          target_id: string | null
          target_table: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          diff?: Json | null
          id?: string
          org_id: string
          target_id?: string | null
          target_table?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          diff?: Json | null
          id?: string
          org_id?: string
          target_id?: string | null
          target_table?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_logs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      brand_platform_metrics: {
        Row: {
          ad_revenue: number | null
          ad_spend: number | null
          brand_id: string
          created_at: string
          currency: string
          extra: Json
          fulfillment_errors: number | null
          gmv: number | null
          id: string
          imported_by: string | null
          orders: number | null
          org_id: string
          period_end: string
          period_start: string
          platform: Database["public"]["Enums"]["platform_channel"]
          return_rate: number | null
          returns: number | null
          roas: number | null
          source: string
          units: number | null
          updated_at: string
        }
        Insert: {
          ad_revenue?: number | null
          ad_spend?: number | null
          brand_id: string
          created_at?: string
          currency?: string
          extra?: Json
          fulfillment_errors?: number | null
          gmv?: number | null
          id?: string
          imported_by?: string | null
          orders?: number | null
          org_id: string
          period_end: string
          period_start: string
          platform: Database["public"]["Enums"]["platform_channel"]
          return_rate?: number | null
          returns?: number | null
          roas?: number | null
          source?: string
          units?: number | null
          updated_at?: string
        }
        Update: {
          ad_revenue?: number | null
          ad_spend?: number | null
          brand_id?: string
          created_at?: string
          currency?: string
          extra?: Json
          fulfillment_errors?: number | null
          gmv?: number | null
          id?: string
          imported_by?: string | null
          orders?: number | null
          org_id?: string
          period_end?: string
          period_start?: string
          platform?: Database["public"]["Enums"]["platform_channel"]
          return_rate?: number | null
          returns?: number | null
          roas?: number | null
          source?: string
          units?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "brand_platform_metrics_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "brands"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "brand_platform_metrics_imported_by_fkey"
            columns: ["imported_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "brand_platform_metrics_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      brands: {
        Row: {
          account_tier: string | null
          category: string | null
          created_at: string
          gmv_share: number | null
          id: string
          legal_name: string | null
          name: string
          onboarding_status: string
          org_id: string
          platform_focus: string[]
          primary_contact_email: string | null
          primary_contact_name: string | null
          primary_contact_phone: string | null
          status: string
          updated_at: string
        }
        Insert: {
          account_tier?: string | null
          category?: string | null
          created_at?: string
          gmv_share?: number | null
          id?: string
          legal_name?: string | null
          name: string
          onboarding_status?: string
          org_id: string
          platform_focus?: string[]
          primary_contact_email?: string | null
          primary_contact_name?: string | null
          primary_contact_phone?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          account_tier?: string | null
          category?: string | null
          created_at?: string
          gmv_share?: number | null
          id?: string
          legal_name?: string | null
          name?: string
          onboarding_status?: string
          org_id?: string
          platform_focus?: string[]
          primary_contact_email?: string | null
          primary_contact_name?: string | null
          primary_contact_phone?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "brands_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      departments: {
        Row: {
          created_at: string
          id: string
          lead_user_id: string | null
          name: string
          org_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          lead_user_id?: string | null
          name: string
          org_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          lead_user_id?: string | null
          name?: string
          org_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "departments_lead_user_id_fkey"
            columns: ["lead_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "departments_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      document_chunks: {
        Row: {
          chunk_index: number
          content: string
          created_at: string
          document_id: string
          embedding: string | null
          id: string
          org_id: string
        }
        Insert: {
          chunk_index: number
          content: string
          created_at?: string
          document_id: string
          embedding?: string | null
          id?: string
          org_id: string
        }
        Update: {
          chunk_index?: number
          content?: string
          created_at?: string
          document_id?: string
          embedding?: string | null
          id?: string
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_chunks_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_chunks_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          chunk_count: number
          created_at: string
          department_id: string | null
          id: string
          org_id: string
          sensitivity: string
          source_type: string
          status: string
          storage_path: string | null
          title: string
          updated_at: string
          uploaded_by: string | null
        }
        Insert: {
          chunk_count?: number
          created_at?: string
          department_id?: string | null
          id?: string
          org_id: string
          sensitivity?: string
          source_type?: string
          status?: string
          storage_path?: string | null
          title: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Update: {
          chunk_count?: number
          created_at?: string
          department_id?: string | null
          id?: string
          org_id?: string
          sensitivity?: string
          source_type?: string
          status?: string
          storage_path?: string | null
          title?: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "documents_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      metrics_snapshots: {
        Row: {
          brand_id: string | null
          capacity_utilization: number
          created_at: string
          created_by: string | null
          department_id: string | null
          efficiency: number
          gmv_impact: number
          id: string
          org_id: string
          period_end: string
          period_start: string
          quality_score: number
          source: string | null
          synced_at: string | null
          updated_at: string
        }
        Insert: {
          brand_id?: string | null
          capacity_utilization?: number
          created_at?: string
          created_by?: string | null
          department_id?: string | null
          efficiency?: number
          gmv_impact?: number
          id?: string
          org_id: string
          period_end: string
          period_start: string
          quality_score?: number
          source?: string | null
          synced_at?: string | null
          updated_at?: string
        }
        Update: {
          brand_id?: string | null
          capacity_utilization?: number
          created_at?: string
          created_by?: string | null
          department_id?: string | null
          efficiency?: number
          gmv_impact?: number
          id?: string
          org_id?: string
          period_end?: string
          period_start?: string
          quality_score?: number
          source?: string | null
          synced_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "metrics_snapshots_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "brands"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "metrics_snapshots_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "metrics_snapshots_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "metrics_snapshots_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          id: string
          name: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "organizations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          brand_id: string | null
          created_at: string
          created_by: string | null
          department_id: string | null
          description: string | null
          due_date: string | null
          id: string
          name: string
          org_id: string
          owner_id: string | null
          status: Database["public"]["Enums"]["project_status"]
          updated_at: string
        }
        Insert: {
          brand_id?: string | null
          created_at?: string
          created_by?: string | null
          department_id?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          name: string
          org_id: string
          owner_id?: string | null
          status?: Database["public"]["Enums"]["project_status"]
          updated_at?: string
        }
        Update: {
          brand_id?: string | null
          created_at?: string
          created_by?: string | null
          department_id?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          name?: string
          org_id?: string
          owner_id?: string | null
          status?: Database["public"]["Enums"]["project_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "projects_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "brands"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      tony_memory: {
        Row: {
          category: string
          content: string
          created_at: string
          created_by: string | null
          id: string
          org_id: string
          pinned: boolean
          source: string | null
          updated_at: string
        }
        Insert: {
          category?: string
          content: string
          created_at?: string
          created_by?: string | null
          id?: string
          org_id: string
          pinned?: boolean
          source?: string | null
          updated_at?: string
        }
        Update: {
          category?: string
          content?: string
          created_at?: string
          created_by?: string | null
          id?: string
          org_id?: string
          pinned?: boolean
          source?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tony_memory_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tony_memory_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      reports: {
        Row: {
          content: Json
          created_at: string
          generated_by: string | null
          id: string
          org_id: string
          period_end: string
          period_start: string
          title: string
          type: Database["public"]["Enums"]["report_type"]
        }
        Insert: {
          content?: Json
          created_at?: string
          generated_by?: string | null
          id?: string
          org_id: string
          period_end: string
          period_start: string
          title: string
          type?: Database["public"]["Enums"]["report_type"]
        }
        Update: {
          content?: Json
          created_at?: string
          generated_by?: string | null
          id?: string
          org_id?: string
          period_end?: string
          period_start?: string
          title?: string
          type?: Database["public"]["Enums"]["report_type"]
        }
        Relationships: [
          {
            foreignKeyName: "reports_generated_by_fkey"
            columns: ["generated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reports_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      skill_registry: {
        Row: {
          backing: string | null
          category: string
          created_at: string
          created_by: string | null
          description: string | null
          enabled: boolean
          id: string
          input_schema: Json
          key: string
          name: string
          org_id: string
          output_shape: string | null
          required_role: string
          updated_at: string
        }
        Insert: {
          backing?: string | null
          category?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          enabled?: boolean
          id?: string
          input_schema?: Json
          key: string
          name: string
          org_id: string
          output_shape?: string | null
          required_role?: string
          updated_at?: string
        }
        Update: {
          backing?: string | null
          category?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          enabled?: boolean
          id?: string
          input_schema?: Json
          key?: string
          name?: string
          org_id?: string
          output_shape?: string | null
          required_role?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "skill_registry_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      task_attachments: {
        Row: {
          created_at: string
          file_name: string | null
          file_type: string | null
          file_url: string
          id: string
          task_id: string
          uploaded_by: string | null
        }
        Insert: {
          created_at?: string
          file_name?: string | null
          file_type?: string | null
          file_url: string
          id?: string
          task_id: string
          uploaded_by?: string | null
        }
        Update: {
          created_at?: string
          file_name?: string | null
          file_type?: string | null
          file_url?: string
          id?: string
          task_id?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "task_attachments_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_attachments_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      task_comments: {
        Row: {
          author_id: string | null
          body: string
          created_at: string
          id: string
          task_id: string
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          body: string
          created_at?: string
          id?: string
          task_id: string
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          body?: string
          created_at?: string
          id?: string
          task_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_comments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_comments_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          assignee_id: string | null
          brand_id: string | null
          created_at: string
          created_by: string | null
          description: string | null
          due_date: string | null
          id: string
          org_id: string
          parent_task_id: string | null
          priority: Database["public"]["Enums"]["task_priority"]
          project_id: string | null
          status: Database["public"]["Enums"]["task_status"]
          title: string
          updated_at: string
        }
        Insert: {
          assignee_id?: string | null
          brand_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          org_id: string
          parent_task_id?: string | null
          priority?: Database["public"]["Enums"]["task_priority"]
          project_id?: string | null
          status?: Database["public"]["Enums"]["task_status"]
          title: string
          updated_at?: string
        }
        Update: {
          assignee_id?: string | null
          brand_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          org_id?: string
          parent_task_id?: string | null
          priority?: Database["public"]["Enums"]["task_priority"]
          project_id?: string | null
          status?: Database["public"]["Enums"]["task_status"]
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_assignee_id_fkey"
            columns: ["assignee_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "brands"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_parent_task_id_fkey"
            columns: ["parent_task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          brand_theme: Json | null
          created_at: string
          id: string
          name: string
          plan: string
          updated_at: string
        }
        Insert: {
          brand_theme?: Json | null
          created_at?: string
          id?: string
          name: string
          plan?: string
          updated_at?: string
        }
        Update: {
          brand_theme?: Json | null
          created_at?: string
          id?: string
          name?: string
          plan?: string
          updated_at?: string
        }
        Relationships: []
      }
      users: {
        Row: {
          avatar_url: string | null
          created_at: string
          department_id: string | null
          email: string
          full_name: string
          id: string
          org_id: string
          role: Database["public"]["Enums"]["user_role"]
          team_assignment: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          department_id?: string | null
          email: string
          full_name: string
          id: string
          org_id: string
          role?: Database["public"]["Enums"]["user_role"]
          team_assignment?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          department_id?: string | null
          email?: string
          full_name?: string
          id?: string
          org_id?: string
          role?: Database["public"]["Enums"]["user_role"]
          team_assignment?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "users_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "users_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      current_org_id: { Args: never; Returns: string }
      current_user_role: {
        Args: never
        Returns: Database["public"]["Enums"]["user_role"]
      }
      decide_approval: {
        Args: { p_decision: string; p_note?: string; p_request_id: string }
        Returns: {
          action_type: string
          created_at: string
          id: string
          org_id: string
          payload: Json
          requested_by: string | null
          requested_by_agent: boolean
          review_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          risk_tier: Database["public"]["Enums"]["risk_tier"]
          status: Database["public"]["Enums"]["approval_status"]
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "approval_requests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      match_document_chunks: {
        Args: { query_embedding: string; match_count?: number }
        Returns: {
          id: string
          document_id: string
          content: string
          title: string
          source_type: string
          similarity: number
        }[]
      }
    }
    Enums: {
      approval_status: "pending" | "approved" | "rejected"
      platform_channel:
        | "tiktok_shop"
        | "shopee"
        | "lazada"
        | "meta_ads"
        | "tiktok_ads"
        | "google_ads"
        | "other"
      project_status: "active" | "planned" | "on_hold" | "completed" | "archived"
      report_type: "daily" | "weekly" | "monthly"
      risk_tier: "LOW" | "MED" | "HIGH" | "CRIT"
      task_priority: "low" | "medium" | "high" | "urgent"
      task_status: "todo" | "in_progress" | "blocked" | "done" | "cancelled"
      user_role: "ceo" | "coo" | "department_head" | "team_member"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      approval_status: ["pending", "approved", "rejected"],
      platform_channel: [
        "tiktok_shop",
        "shopee",
        "lazada",
        "meta_ads",
        "tiktok_ads",
        "google_ads",
        "other",
      ],
      project_status: ["active", "planned", "on_hold", "completed", "archived"],
      report_type: ["daily", "weekly", "monthly"],
      risk_tier: ["LOW", "MED", "HIGH", "CRIT"],
      task_priority: ["low", "medium", "high", "urgent"],
      task_status: ["todo", "in_progress", "blocked", "done", "cancelled"],
      user_role: ["ceo", "coo", "department_head", "team_member"],
    },
  },
} as const

// --- Mthryve additions -------------------------------------------------------
// Friendly aliases so app code can import names instead of deep Enums lookups.
export type UserRole = Database["public"]["Enums"]["user_role"]
export type TaskStatus = Database["public"]["Enums"]["task_status"]
export type TaskPriority = Database["public"]["Enums"]["task_priority"]
export type ProjectStatus = Database["public"]["Enums"]["project_status"]
export type ApprovalStatus = Database["public"]["Enums"]["approval_status"]
export type RiskTier = Database["public"]["Enums"]["risk_tier"]
export type PlatformChannel = Database["public"]["Enums"]["platform_channel"]

export type TaskRow = Database["public"]["Tables"]["tasks"]["Row"]
export type ProjectRow = Database["public"]["Tables"]["projects"]["Row"]
export type TaskCommentRow = Database["public"]["Tables"]["task_comments"]["Row"]
export type AiConversationRow = Database["public"]["Tables"]["ai_conversations"]["Row"]
export type AiMessageRow = Database["public"]["Tables"]["ai_messages"]["Row"]
export type ApprovalRequestRow = Database["public"]["Tables"]["approval_requests"]["Row"]
export type AuditLogRow = Database["public"]["Tables"]["audit_logs"]["Row"]
export type MetricsSnapshotRow = Database["public"]["Tables"]["metrics_snapshots"]["Row"]
export type ReportRow = Database["public"]["Tables"]["reports"]["Row"]
export type BrandRow = Database["public"]["Tables"]["brands"]["Row"]
export type BrandPlatformMetricsRow = Database["public"]["Tables"]["brand_platform_metrics"]["Row"]
export type BrandPlatformMetricsInsert = Database["public"]["Tables"]["brand_platform_metrics"]["Insert"]
export type TonyMemoryRow = Database["public"]["Tables"]["tony_memory"]["Row"]
export type TonyMemoryInsert = Database["public"]["Tables"]["tony_memory"]["Insert"]
export type SkillRegistryRow = Database["public"]["Tables"]["skill_registry"]["Row"]
export type DocumentRow = Database["public"]["Tables"]["documents"]["Row"]
export type DocumentInsert = Database["public"]["Tables"]["documents"]["Insert"]
export type DocumentChunkRow = Database["public"]["Tables"]["document_chunks"]["Row"]
export type DocumentChunkInsert = Database["public"]["Tables"]["document_chunks"]["Insert"]

export type MetricCatalogRow = Database["public"]["Tables"]["metric_catalog"]["Row"]
export type MetricCatalogInsert = Database["public"]["Tables"]["metric_catalog"]["Insert"]
export type MetricEntryRow = Database["public"]["Tables"]["metric_entries"]["Row"]
export type MetricEntryInsert = Database["public"]["Tables"]["metric_entries"]["Insert"]
export type MetricEntryUpdate = Database["public"]["Tables"]["metric_entries"]["Update"]
export type MetricTargetRow = Database["public"]["Tables"]["metric_targets"]["Row"]

// documents.source_type / status / sensitivity are free text on the live table
// (no PG enum) but the app treats them as closed sets.
export type DocumentSourceType = "sop" | "playbook" | "contract" | "report" | "other"
export type DocumentStatus = "processing" | "ready" | "failed"
export type DocumentSensitivity = "org" | "leadership"
