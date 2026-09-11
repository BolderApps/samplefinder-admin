import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Login from './pages/Login'
import ForgotPassword from './pages/ForgotPassword'
import PasswordReset from './pages/PasswordReset'
import PasswordResetSuccess from './pages/PasswordResetSuccess'
import EmailConfirmation from './pages/EmailConfirmation'
import Dashboard from './pages/Dashboard/Dashboard'
import EventReviews from './pages/EventReviews/EventReviews'
import ClientsBrands from './pages/ClientsBrands/ClientsBrands'
import Users from './pages/Users/Users'
import Categories from './pages/Categories/Categories'
import Reports from './pages/Reports/Reports'
import PreviewReports from './pages/Reports/PreviewReports'
import ReportBuilder from './pages/Reports/ReportBuilder'
import Notifications from './pages/Notifications/Notifications'
import Trivia from './pages/Trivia/Trivia'
import TriviaDetails from './pages/Trivia/TriviaDetails'
import Popups from './pages/Popups/Popups'
import PopupDetails from './pages/Popups/PopupDetails'
import Locations from './pages/Locations/Locations'
import { ProtectedRoute } from './components'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Login />} />
        <Route path="/login" element={<Login />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/password-reset" element={<PasswordReset />} />
        <Route path="/password-reset-success" element={<PasswordResetSuccess />} />
        <Route path="/email-confirmation" element={<EmailConfirmation />} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/event-reviews/:eventId?"
          element={
            <ProtectedRoute>
              <EventReviews />
            </ProtectedRoute>
          }
        />
        <Route
          path="/clients-brands"
          element={
            <ProtectedRoute>
              <ClientsBrands />
            </ProtectedRoute>
          }
        />
        <Route
          path="/app-users"
          element={
            <ProtectedRoute>
              <Users />
            </ProtectedRoute>
          }
        />
        <Route
          path="/categories"
          element={
            <ProtectedRoute>
              <Categories />
            </ProtectedRoute>
          }
        />
        <Route
          path="/locations"
          element={
            <ProtectedRoute>
              <Locations />
            </ProtectedRoute>
          }
        />
        <Route
          path="/reports"
          element={
            <ProtectedRoute>
              <Reports />
            </ProtectedRoute>
          }
        />
        <Route
          path="/reports/preview/:reportId"
          element={
            <ProtectedRoute>
              <PreviewReports />
            </ProtectedRoute>
          }
        />
        <Route
          path="/reports/builder"
          element={
            <ProtectedRoute>
              <ReportBuilder />
            </ProtectedRoute>
          }
        />
        <Route
          path="/notification-settings"
          element={
            <ProtectedRoute>
              <Notifications />
            </ProtectedRoute>
          }
        />
        <Route
          path="/trivia"
          element={
            <ProtectedRoute>
              <Trivia />
            </ProtectedRoute>
          }
        />
        <Route
          path="/trivia/:triviaId"
          element={
            <ProtectedRoute>
              <TriviaDetails />
            </ProtectedRoute>
          }
        />
        <Route
          path="/popups"
          element={
            <ProtectedRoute>
              <Popups />
            </ProtectedRoute>
          }
        />
        <Route
          path="/popups/:popupId"
          element={
            <ProtectedRoute>
              <PopupDetails />
            </ProtectedRoute>
          }
        />
      </Routes>
    </BrowserRouter>
  )
}

export default App
