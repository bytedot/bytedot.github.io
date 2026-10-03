(() => {
  const form = document.getElementById('application-form');
  if (!form) return;

  const username = document.getElementById('application-username');
  const identifier = document.getElementById('application-identifier');
  const progress = document.getElementById('identifier-progress');
  const reason = document.getElementById('application-reason');
  const otherField = document.getElementById('application-other-field');
  const otherReason = document.getElementById('application-other-reason');
  const error = document.getElementById('username-error');
  const loading = document.getElementById('username-loading');
  const status = document.getElementById('application-status');
  const submit = document.getElementById('application-submit');
  const fields = [username, identifier, reason, otherReason];
  let checking = false;

  function clearError() {
    username.removeAttribute('aria-invalid');
    error.hidden = true;
    status.hidden = true;
    status.textContent = '';
  }

  function updateSubmit() {
    submit.disabled = checking || identifier.value.length !== 9;
  }

  function updateIdentifier() {
    identifier.value = identifier.value.replace(/[^0-9]/g, '').slice(0, 9);
    progress.textContent = `已输入 ${identifier.value.length} / 9 位`;
    updateSubmit();
  }

  function updateReason() {
    const isOther = reason.value === 'other';
    otherField.hidden = !isOther;
    if (!isOther) otherReason.value = '';
  }

  function setChecking(value) {
    checking = value;
    form.setAttribute('aria-busy', String(value));
    for (const field of fields) field.disabled = value;
    loading.hidden = !value;
    submit.textContent = value ? '正在检查…' : '提交申请';
    status.classList.toggle('is-checking', value);
    updateSubmit();
  }

  for (const field of fields) {
    field.addEventListener('input', () => {
      if (!checking) clearError();
    });
  }
  identifier.addEventListener('input', updateIdentifier);
  reason.addEventListener('change', () => {
    clearError();
    updateReason();
  });

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (checking || identifier.value.length !== 9) return;
    clearError();
    setChecking(true);
    status.textContent = '正在检查用户名…';
    status.hidden = false;

    setTimeout(() => {
      setChecking(false);
      username.setAttribute('aria-invalid', 'true');
      error.hidden = false;
      status.textContent = '申请未完成：用户名已被占用，请更换用户名。';
      username.focus();
    }, 1600);
  });

  updateIdentifier();
  updateReason();
})();
