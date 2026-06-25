export const up = (pgm) => {
  pgm.createTable('check_rollups', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    monitor_id: { type: 'uuid', notNull: true, references: 'monitors(id)', onDelete: 'CASCADE' },
    date: { type: 'date', notNull: true },
    total_checks: { type: 'integer', notNull: true, default: 0 },
    up_count: { type: 'integer', notNull: true, default: 0 },
    down_count: { type: 'integer', notNull: true, default: 0 },
    timeout_count: { type: 'integer', notNull: true, default: 0 },
    avg_response_ms: { type: 'integer' },
    min_response_ms: { type: 'integer' },
    max_response_ms: { type: 'integer' },
  });

  pgm.addConstraint('check_rollups', 'check_rollups_monitor_date_unique',
    'UNIQUE(monitor_id, date)');
};

export const down = (pgm) => {
  pgm.dropTable('check_rollups');
};
