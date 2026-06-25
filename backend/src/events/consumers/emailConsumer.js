import nodemailer from 'nodemailer';
import { findUserById } from '../../db/users.queries.js';

let transporter = null;

const getTransporter = async () => {
  if (transporter) return transporter;

  if (process.env.SMTP_HOST) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  } else {
    const testAccount = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: testAccount.smtp.host,
      port: testAccount.smtp.port,
      secure: testAccount.smtp.secure,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass,
      },
    });
  }

  return transporter;
};

const sendEmail = async (to, subject, text) => {
  const transport = await getTransporter();
  const from = process.env.SMTP_FROM || 'alerts@uptime-monitor.local';

  const info = await transport.sendMail({ from, to, subject, text });

  const previewUrl = nodemailer.getTestMessageUrl(info);
  if (previewUrl) {
    console.error(`Email preview: ${previewUrl}`);
  }
};

export const handleEmailEvent = async (event) => {
  try {
    const user = await findUserById(event.userId);
    if (!user) return;

    if (event.type === 'monitor.down') {
      await sendEmail(
        user.email,
        `🔴 ${event.monitorName} is DOWN`,
        [
          `Your monitor "${event.monitorName}" is down.`,
          '',
          `URL: ${event.url}`,
          `Consecutive failures: ${event.consecutiveFailures}`,
          `Failure threshold: ${event.failureThreshold}`,
          `Detected at: ${event.timestamp}`,
        ].join('\n')
      );
    }

    if (event.type === 'monitor.recovered') {
      await sendEmail(
        user.email,
        `✅ ${event.monitorName} is back UP`,
        [
          `Your monitor "${event.monitorName}" has recovered.`,
          '',
          `URL: ${event.url}`,
          `Recovered at: ${event.timestamp}`,
        ].join('\n')
      );
    }
  } catch (err) {
    console.error('Email consumer error:', err.message);
  }
};
