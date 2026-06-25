export const schema = {
  users: {
    id:            'uuid          PK   gen_random_uuid()',
    clerk_user_id: 'varchar       NOT NULL  UNIQUE',
    email:         'varchar       NOT NULL  UNIQUE',
    slack_webhook_url: 'varchar   nullable',
    created_at:    'timestamptz   NOT NULL  default now()',
  },

  groups: {
    id:         'uuid          PK   gen_random_uuid()',
    user_id:    'uuid          NOT NULL  FK → users.id  ON DELETE CASCADE',
    name:       'varchar       NOT NULL',
    created_at: 'timestamptz   NOT NULL  default now()',
    _constraints: [
      'UNIQUE(user_id, name)',
    ],
  },

  monitors: {
    id:                   'uuid          PK   gen_random_uuid()',
    user_id:              'uuid          NOT NULL  FK → users.id  ON DELETE CASCADE',
    group_id:             'uuid          nullable  FK → groups.id  ON DELETE SET NULL',
    name:                 'varchar       NOT NULL',
    url:                  'varchar       NOT NULL',
    interval_minutes:     'integer       NOT NULL  default 5',
    failure_threshold:    'integer       NOT NULL  default 2',
    consecutive_failures: 'integer       NOT NULL  default 0',
    is_alerted:           'boolean       NOT NULL  default false',
    last_status:          'varchar       nullable  CHECK IN (up, down, timeout)',
    last_checked_at:      'timestamptz   nullable',
    next_check_at:        'timestamptz   nullable',
    is_active:            'boolean       NOT NULL  default true',
    is_deleted:           'boolean       NOT NULL  default false',
    created_at:           'timestamptz   NOT NULL  default now()',
    updated_at:           'timestamptz   NOT NULL  default now()',
  },

  check_logs: {
    id:               'uuid          PK   gen_random_uuid()',
    monitor_id:       'uuid          NOT NULL  FK → monitors.id  ON DELETE CASCADE',
    status:           'varchar       NOT NULL  CHECK IN (up, down, timeout)',
    response_code:    'integer       nullable',
    response_time_ms: 'integer       nullable',
    message:          'text          nullable',
    checked_at:       'timestamptz   NOT NULL  default now()',
    job_id:           'varchar       nullable  UNIQUE  (BullMQ job id — idempotency key)',
  },

  check_rollups: {
    id:               'uuid          PK   gen_random_uuid()',
    monitor_id:       'uuid          NOT NULL  FK → monitors.id  ON DELETE CASCADE',
    date:             'date          NOT NULL',
    total_checks:     'integer       NOT NULL  default 0',
    up_count:         'integer       NOT NULL  default 0',
    down_count:       'integer       NOT NULL  default 0',
    timeout_count:    'integer       NOT NULL  default 0',
    avg_response_ms:  'integer       nullable',
    min_response_ms:  'integer       nullable',
    max_response_ms:  'integer       nullable',
    _constraints: [
      'UNIQUE(monitor_id, date)',
    ],
  },
};
