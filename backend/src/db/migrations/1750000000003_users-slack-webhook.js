export const up = (pgm) => {
  pgm.addColumn('users', {
    slack_webhook_url: { type: 'varchar', notNull: false },
  });
};

export const down = (pgm) => {
  pgm.dropColumn('users', 'slack_webhook_url');
};
