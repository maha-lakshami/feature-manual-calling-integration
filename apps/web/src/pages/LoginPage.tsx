/// <reference types="vite/client" />

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, Eye, EyeOff, Loader2, ShieldCheck, Sparkles, Zap } from 'lucide-react';
import { ApiError } from '../api/client';
import { useAuth } from '../context/AuthContext';
import './LoginPage.css';

type QuickPersona = 'admin' | 'manager' | 'staff';

const getLoginErrorMessage = (error: unknown): string => {
  if (error instanceof ApiError && (error.status === 400 || error.status === 401)) {
    return 'Incorrect email or password.';
  }
  return 'Unable to sign in right now. Please try again.';
};

export const LoginPage: React.FC = () => {
  const { login, quickLogin } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      await login(email, password);
      navigate('/');
    } catch (loginError: unknown) {
      setError(getLoginErrorMessage(loginError));
    } finally {
      setIsLoading(false);
    }
  };

  const handleQuickLogin = async (persona: QuickPersona) => {
    setIsLoading(true);
    setError(null);
    try {
      await quickLogin(persona);
      navigate('/');
    } catch (loginError: unknown) {
      setError(getLoginErrorMessage(loginError));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="login-page">
      <div className="login-orb login-orb--one" aria-hidden="true" />
      <div className="login-orb login-orb--two" aria-hidden="true" />
      <div className="login-wave login-wave--back" aria-hidden="true" />
      <div className="login-wave login-wave--front" aria-hidden="true" />

      <div className="login-shell">
        <section className="login-story" aria-label="Aiking Connect introduction">
          <div className="login-story__brand"><span><Zap size={22} /></span>Aiking Connect</div>
          <div className="login-story__copy">
            <div className="login-story__eyebrow"><Sparkles size={15} /> Unified customer operations</div>
            <h1>Customer communication, simplified.</h1>
            <p>Coordinate conversations, campaigns, calls, and customer relationships from one secure workspace.</p>
          </div>
          <div className="login-story__trust"><ShieldCheck size={18} /><span>Protected workspace access</span></div>
        </section>

        <section className="login-card" aria-labelledby="login-title">
          <div className="login-card__accent" aria-hidden="true" />
          <div className="login-brand-mark" aria-hidden="true"><Zap size={25} strokeWidth={2.25} /></div>
          <header className="login-heading"><h2 id="login-title">Welcome back</h2><p>Sign in to your Aiking Connect workspace</p></header>

          {error && <div className="login-error" role="alert" aria-live="polite"><AlertCircle size={17} aria-hidden="true" /><span>{error}</span></div>}

          <form className="login-form" onSubmit={handleSubmit}>
            <div className="login-field">
              <label htmlFor="login-email">Email</label>
              <input id="login-email" name="email" type="email" autoComplete="email" required placeholder="name@company.com" value={email} onChange={(event) => setEmail(event.target.value)} className="input-field" />
            </div>
            <div className="login-field">
              <label htmlFor="login-password">Password</label>
              <div className="login-password-field">
                <input id="login-password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required placeholder="Enter your password" value={password} onChange={(event) => setPassword(event.target.value)} className="input-field" />
                <button type="button" className="login-password-toggle" onClick={() => setShowPassword((current) => !current)} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword}>{showPassword ? <EyeOff size={19} /> : <Eye size={19} />}</button>
              </div>
            </div>
            <button type="submit" disabled={isLoading} className="btn btn-primary btn-lg login-submit">{isLoading ? <><Loader2 size={18} className="animate-spin" aria-hidden="true" />Signing in...</> : 'Sign In'}</button>
          </form>

          <p className="login-footer"><ShieldCheck size={14} /> Secure access to Aiking Connect</p>

          {import.meta.env.DEV && (
            <details className="login-dev-accounts">
              <summary>Developer test accounts</summary>
              <div className="login-dev-actions">
                <button type="button" disabled={isLoading} onClick={() => handleQuickLogin('manager')}>Manager</button>
                <button type="button" disabled={isLoading} onClick={() => handleQuickLogin('admin')}>Super Admin</button>
                <button type="button" disabled={isLoading} onClick={() => handleQuickLogin('staff')}>Staff</button>
              </div>
            </details>
          )}
        </section>
      </div>
    </main>
  );
};
