export const up = (pgm) => {
  pgm.addConstraint('users', 'users_email_unique', 'UNIQUE(email)');
};

export const down = (pgm) => {
  pgm.dropConstraint('users', 'users_email_unique');
};
