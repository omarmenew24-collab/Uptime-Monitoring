export const up = (pgm) => {
  pgm.createTable('users', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    clerk_user_id: { type: 'varchar', notNull: true, unique: true },
    email: { type: 'varchar', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('groups', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    name: { type: 'varchar', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('groups', 'groups_user_id_name_unique', 'UNIQUE(user_id, name)');

  pgm.createTable('monitors', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    group_id: { type: 'uuid', references: 'groups(id)', onDelete: 'SET NULL' },
    name: { type: 'varchar', notNull: true },
    url: { type: 'varchar', notNull: true },
    interval_minutes: { type: 'integer', notNull: true, default: 5 },
    failure_threshold: { type: 'integer', notNull: true, default: 2 },
    consecutive_failures: { type: 'integer', notNull: true, default: 0 },
    is_alerted: { type: 'boolean', notNull: true, default: false },
    last_status: { type: 'varchar' },
    last_checked_at: { type: 'timestamptz' },
    next_check_at: { type: 'timestamptz' },
    is_active: { type: 'boolean', notNull: true, default: true },
    is_deleted: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('monitors', 'monitors_last_status_check',
    `CHECK (last_status IN ('up', 'down', 'timeout'))`);

  pgm.createTable('check_logs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    monitor_id: { type: 'uuid', notNull: true, references: 'monitors(id)', onDelete: 'CASCADE' },
    status: { type: 'varchar', notNull: true },
    response_code: { type: 'integer' },
    response_time_ms: { type: 'integer' },
    message: { type: 'text' },
    checked_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('check_logs', 'check_logs_status_check',
    `CHECK (status IN ('up', 'down', 'timeout'))`);

  // Indexes
  pgm.createIndex('monitors', 'user_id', {
    where: 'is_deleted = false',
    name: 'monitors_user_id_active_idx',
  });

  pgm.createIndex('monitors', 'next_check_at', {
    where: 'is_active = true AND is_deleted = false',
    name: 'monitors_next_check_at_idx',
  });

  pgm.createIndex('check_logs', ['monitor_id', 'checked_at'], {
    name: 'check_logs_monitor_id_checked_at_idx',
  });
};

export const down = (pgm) => {
  pgm.dropTable('check_logs');
  pgm.dropTable('monitors');
  pgm.dropTable('groups');
  pgm.dropTable('users');
};
