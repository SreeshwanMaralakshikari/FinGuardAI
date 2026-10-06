/**
 * @file src/pages/customer/Profile.jsx
 * @description GET/PATCH /customer-api/profile (CUSTOMER only) + change password (AUD-31, AUD-35).
 *   The update is ALWAYS sent as multipart FormData with NO Content-Type header (the browser adds
 *   the boundary); field name `profileImage`, JPEG/PNG/WebP ≤ 2 MB. Because the body is always
 *   multipart, req.body is defined on the server even for a name-only change.
 *   N-16: the name is validated trimmed (same rule as registration) and the file input is
 *   re-mounted (key) after every save / rejection, so picking the same file again fires `change`.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import { useAppDispatch, useAppSelector } from '../../store/hooks.js';
import { updateUser } from '../../store/slices/authSlice.js';
import api from '../../api/axios.js';
import { getErrorMessage } from '../../api/errors.js';
import { API_PATHS } from '../../utils/constants.js';
import { BTN, CARD, formatDate, getInitials } from '../../utils/common.js';
import { validateName } from '../../utils/forms.js';
import { useFetch } from '../../hooks/useFetch.js';
import PageHeader from '../../components/common/PageHeader.jsx';
import Spinner from '../../components/common/Spinner.jsx';
import FormField from '../../components/common/FormField.jsx';
import Alert from '../../components/common/Alert.jsx';
import LoadError from '../../components/common/LoadError.jsx';
import DetailRow from '../../components/common/DetailRow.jsx';
import ChangePasswordForm from '../../components/shared/ChangePasswordForm.jsx';

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 2 * 1024 * 1024;

export default function Profile() {
  const dispatch = useAppDispatch();
  const authUser = useAppSelector((s) => s.auth.user);
  const { data, loading, error, reload } = useFetch(
    async () => (await api.get(API_PATHS.CUSTOMER.PROFILE)).data.data,
    [],
  );
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState('');
  const [fileError, setFileError] = useState('');
  const [fileInputKey, setFileInputKey] = useState(0);
  const [serverError, setServerError] = useState('');
  const {
    register, handleSubmit, reset, formState: { errors, isSubmitting },
  } = useForm({ defaultValues: { name: '' } });

  useEffect(() => { if (data) reset({ name: data.name }); }, [data, reset]);

  // Free the previous object URL whenever the preview changes or the page unmounts.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const onPick = (e) => {
    const f = e.target.files?.[0];
    setFileError('');
    setPreview('');
    if (!f) { setFile(null); return; }
    if (!ALLOWED.includes(f.type)) { setFile(null); setFileError('Only JPG, PNG or WebP images are allowed.'); setFileInputKey((k) => k + 1); return; }
    if (f.size > MAX_BYTES) { setFile(null); setFileError('The image must be 2 MB or smaller.'); setFileInputKey((k) => k + 1); return; }
    setFile(f);
    setPreview(URL.createObjectURL(f));
  };

  const onSubmit = async ({ name }) => {
    setServerError('');
    const fd = new FormData();
    fd.append('name', name.trim());
    if (file) fd.append('profileImage', file);
    try {
      // No Content-Type header — the browser sets multipart/form-data with the boundary (AUD-31)
      const res = await api.patch(API_PATHS.CUSTOMER.PROFILE, fd);
      const updated = res.data.data;
      dispatch(updateUser({ name: updated.name, profileImage: updated.profileImage ?? null }));
      setFile(null);
      setPreview('');
      setFileInputKey((k) => k + 1);
      toast.success('Profile updated');
      reload();
    } catch (err) {
      setServerError(getErrorMessage(err, 'Could not update your profile'));
    }
  };

  if (loading && !data) return <Spinner />;
  // N-02: a failed load shows the error + Retry, not an empty form that would overwrite the real name
  if (error && !data) {
    return (
      <div className="max-w-2xl space-y-6">
        <PageHeader title="Profile" subtitle="Your name and picture." />
        <LoadError message={error} onRetry={reload} />
      </div>
    );
  }

  const shownImage = preview || data?.profileImage || authUser?.profileImage;

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title="Profile" subtitle="Your name and picture." />
      <LoadError message={error} onRetry={reload} />

      <section className={CARD.base} aria-labelledby="profile-title">
        <div className={CARD.header}><h2 id="profile-title" className="text-base font-semibold text-gray-900">Personal details</h2></div>
        <form onSubmit={handleSubmit(onSubmit, () => setServerError(''))} noValidate className={`${CARD.body} space-y-5`}>
          <Alert tone="error">{serverError}</Alert>

          <div className="flex items-center gap-4">
            {shownImage ? (
              <img src={shownImage} alt="Profile" className="h-20 w-20 rounded-full object-cover" />
            ) : (
              <span className="flex h-20 w-20 items-center justify-center rounded-full bg-primary-600 text-2xl font-semibold text-white" aria-hidden="true">
                {getInitials(data?.name ?? authUser?.name)}
              </span>
            )}
            <div className="min-w-0">
              <label htmlFor="profileImage" className="text-sm font-medium text-gray-700">Profile picture</label>
              <input key={fileInputKey} id="profileImage" type="file" accept="image/jpeg,image/png,image/webp" onChange={onPick} className="mt-1 block w-full max-w-full text-sm text-gray-600" />
              <p className="mt-1 text-xs text-gray-500">JPG, PNG or WebP, up to 2 MB.</p>
              {fileError && <p className="mt-1 text-xs text-red-600" role="alert">{fileError}</p>}
            </div>
          </div>

          <FormField
            name="name"
            label="Full name"
            errors={errors}
            render={(p) => (
              <input
                {...p}
                type="text"
                {...register('name', { validate: validateName })}
              />
            )}
          />

          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <DetailRow label="Email">{data?.email}</DetailRow>
            <DetailRow label="Last sign-in">{formatDate(data?.lastLogin)}</DetailRow>
          </dl>

          <button type="submit" disabled={isSubmitting} className={`${BTN.base} ${BTN.primary} ${BTN.md}`}>
            {isSubmitting ? 'Saving…' : 'Save changes'}
          </button>
        </form>
      </section>

      <ChangePasswordForm />
    </div>
  );
}
