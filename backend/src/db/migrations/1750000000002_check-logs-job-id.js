export const up = (pgm) => {
  pgm.addColumn('check_logs', {
    job_id: { type: 'varchar', notNull: false },
  });
  pgm.addConstraint('check_logs', 'check_logs_job_id_unique', 'UNIQUE(job_id)');
};

export const down = (pgm) => {
  pgm.dropConstraint('check_logs', 'check_logs_job_id_unique');
  pgm.dropColumn('check_logs', 'job_id');
};
