// ============================================================================
// useCreateMonitor.js — ANNOTATED EXPLANATION COPY
//
// This is a teaching copy of frontend/src/hooks/useCreateMonitor.js.
// The real file has no comments (project rule). This one explains every part.
//
// WHAT THIS HOOK IS:
//   A "custom hook" that owns the state of the Create Monitor FORM — the values
//   the user types, whether the dialog is open, and any validation errors.
//
//   It does NOT call the API. That's done by a different hook (useCreateMonitor
//   inside useMonitors.js, which uses React Query). This separation is the
//   whole point: this file = "what the user is typing", the other = "saving it".
// ============================================================================

import { useState, useCallback } from 'react';

// The starting values for a fresh, empty form.
// Defined OUTSIDE the component so it's a single constant, not recreated on
// every render. Note camelCase here (intervalMinutes) — this is the UI's
// naming. The API wants snake_case; we translate at the end (see getSubmitData).
const INITIAL_FORM = {
  name: '',
  url: '',
  intervalMinutes: 5,
  failureThreshold: 2,
};

export default function useCreateMonitorForm() {
  // --- The three pieces of state this hook manages ---

  // Is the dialog open or closed?
  const [open, setOpen] = useState(false);

  // The current form values (starts as a COPY of INITIAL_FORM).
  const [formData, setFormData] = useState(INITIAL_FORM);

  // Validation errors, keyed by field name, e.g. { url: 'URL is required' }.
  // Empty object = no errors.
  const [errors, setErrors] = useState({});

  // --------------------------------------------------------------------------
  // reset — wipe the form back to empty.
  //
  // WHY useCallback: it returns the SAME function instance between renders
  // (instead of creating a new one each time). That matters because other
  // callbacks below depend on `reset` — useCallback keeps the dependency
  // stable so they don't get recreated unnecessarily. The [] means "this
  // function never changes."
  // --------------------------------------------------------------------------
  const reset = useCallback(() => {
    setFormData(INITIAL_FORM);
    setErrors({});
  }, []);

  // --------------------------------------------------------------------------
  // handleOpenChange — open or close the dialog.
  //
  // THE TRICKY PART: when the dialog CLOSES (value === false), we reset the
  // form. So if a user types half a form, closes it, and reopens, they get a
  // clean form — not their old half-typed input. This is why reset is a
  // dependency: this callback uses it.
  // --------------------------------------------------------------------------
  const handleOpenChange = useCallback((value) => {
    setOpen(value);
    if (!value) reset();
  }, [reset]);

  // --------------------------------------------------------------------------
  // updateField — change one field (called on every keystroke / select change).
  //
  // setFormData((prev) => ({ ...prev, [field]: value }))
  //   - prev is the current form object
  //   - { ...prev } copies all existing fields (never MUTATE state directly)
  //   - [field]: value overwrites just the one that changed
  //   - [field] is a "computed key" — the variable's value becomes the key,
  //     so updateField('url', x) sets the `url` property.
  //
  // It also clears that field's error — as soon as the user edits a field,
  // its old error message disappears. Small touch, good UX.
  // --------------------------------------------------------------------------
  const updateField = useCallback((field, value) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: null }));
  }, []);

  // --------------------------------------------------------------------------
  // validate — check the form before sending. Returns true if OK.
  //
  // Builds a fresh errors object, fills it with any problems, stores it in
  // state (so the UI can show the messages), and returns whether it's empty.
  //
  // This is CLIENT-SIDE validation — it's for instant feedback only. The
  // backend Zod schema is the real guard. A user could bypass this, which is
  // exactly why the server validates again. Never trust the client alone.
  // --------------------------------------------------------------------------
  const validate = useCallback(() => {
    const newErrors = {};

    if (!formData.name.trim()) {
      newErrors.name = 'Name is required';
    }

    if (!formData.url.trim()) {
      newErrors.url = 'URL is required';
    } else if (!formData.url.startsWith('http://') && !formData.url.startsWith('https://')) {
      newErrors.url = 'URL must start with http:// or https://';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0; // true = no errors = valid
  }, [formData]);

  // --------------------------------------------------------------------------
  // getSubmitData — produce the exact shape the API expects.
  //
  // THE BOUNDARY TRANSLATION: the UI uses camelCase (intervalMinutes), the
  // backend/database uses snake_case (interval_minutes). We convert here, in
  // ONE place. The rest of the UI never thinks about snake_case; the API never
  // sees camelCase. .trim() removes accidental leading/trailing spaces.
  // --------------------------------------------------------------------------
  const getSubmitData = useCallback(() => ({
    name: formData.name.trim(),
    url: formData.url.trim(),
    interval_minutes: formData.intervalMinutes,
    failure_threshold: formData.failureThreshold,
  }), [formData]);

  // --------------------------------------------------------------------------
  // Everything the component needs, returned as one object. The page/dialog
  // pulls out what it uses. The hook hides HOW the form works; callers just
  // call updateField / validate / getSubmitData.
  // --------------------------------------------------------------------------
  return {
    open,
    setOpen,
    handleOpenChange,
    formData,
    updateField,
    errors,
    validate,
    getSubmitData,
    reset,
  };
}

// ============================================================================
// HOW IT'S USED (in DashboardPage.jsx):
//
//   const form = useCreateMonitorForm();
//
//   const handleSubmit = async () => {
//     if (!form.validate()) return;            // 1. check input
//     await createMyMonitor(form.getSubmitData()); // 2. send to API
//     form.handleOpenChange(false);            // 3. close + reset on success
//   };
//
// The form hook (this file) and the API hook (React Query) are kept separate.
// This file knows nothing about HTTP; the API hook knows nothing about form
// fields. Each does one job. That's the lesson worth taking everywhere.
// ============================================================================
