import { useState, useCallback } from 'react';

const INITIAL_FORM = {
  name: '',
  url: '',
  intervalMinutes: 5,
  failureThreshold: 2,
};

export default function useCreateMonitorForm() {
  const [open, setOpen] = useState(false);
  const [formData, setFormData] = useState(INITIAL_FORM);
  const [errors, setErrors] = useState({});

  const reset = useCallback(() => {
    setFormData(INITIAL_FORM);
    setErrors({});
  }, []);

  const handleOpenChange = useCallback((value) => {
    setOpen(value);
    if (!value) reset();
  }, [reset]);

  const updateField = useCallback((field, value) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: null }));
  }, []);

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
    return Object.keys(newErrors).length === 0;
  }, [formData]);

  const getSubmitData = useCallback(() => ({
    name: formData.name.trim(),
    url: formData.url.trim(),
    interval_minutes: formData.intervalMinutes,
    failure_threshold: formData.failureThreshold,
  }), [formData]);

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
