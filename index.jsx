import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, addDoc, onSnapshot, collection, query, updateDoc, deleteDoc, Timestamp, setLogLevel } from 'firebase/firestore';
import { Clock, User, LogOut, Download, AlertTriangle, CheckCircle, XCircle, Users, BookOpen, Zap, Filter } from 'lucide-react';

// --- Global Constants and Firebase Initialization ---

// Placeholder configuration for local testing if Canvas variables are missing
// Updated with your provided Firebase configuration.
const LOCAL_FIREBASE_CONFIG = {
    apiKey: "AIzaSyCHimNRSSB4ZoqLCu5Okq4yL0i85EMzUIU",
    authDomain: "library-booking-83e2a.firebaseapp.com",
    projectId: "library-booking-83e2a",
    storageBucket: "library-booking-83e2a.firebasestorage.app",
    messagingSenderId: "712017475970",
    appId: "1:712017475970:web:760a61d2bcbde376eff79b",
    measurementId: "G-XEHSTZ2SYD"
};

// Check for Canvas-injected variables and fall back to local/default values
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

let firebaseConfig = null;
if (typeof __firebase_config !== 'undefined') {
    // Running in Canvas environment
    firebaseConfig = JSON.parse(__firebase_config);
} else {
    // Running on Localhost (or outside Canvas), use local config
    console.warn("Using local Firebase configuration fallback for testing.");
    firebaseConfig = LOCAL_FIREBASE_CONFIG;
}

const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

const CABIN_COUNT = 15;
const BOOKING_DURATION_HOURS = 2;
// MANDATORY Firestore path structure for public, shared data
const BOOKINGS_COLLECTION = `artifacts/${appId}/public/data/cabinBookings`;

const cabinCapacities = [4, 5, 6];
const initialCabins = Array.from({ length: CABIN_COUNT }, (_, i) => ({
    id: `C${i + 1}`,
    name: `Cabin ${i + 1}`,
    capacity: cabinCapacities[i % 3],
}));

// Optional: specific logging
// setLogLevel('debug'); 

// --- Helper Functions ---

/**
 * Custom hook for managing the status messages (toasts).
 */
const useAlert = () => {
    const [alert, setAlert] = useState({ message: '', classes: '', visible: false });

    const alertUser = useCallback((message, classes) => {
        setAlert({ message, classes, visible: true });
        // Auto-hide after 6 seconds
        const timer = setTimeout(() => setAlert(prev => ({ ...prev, visible: false })), 6000);
        return () => clearTimeout(timer);
    }, []);

    const AlertComponent = () => (
        <div
            className={`fixed top-6 right-6 p-5 rounded-xl text-left font-semibold shadow-2xl transition-all duration-700 ease-out z-50 
                ${alert.classes} ${alert.visible ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-full pointer-events-none'}
                flex items-center space-x-3 backdrop-blur-md border border-white/20
            `}
            role="alert"
        >
            {alert.message}
        </div>
    );

    return [alertUser, AlertComponent];
};

/**
 * Calculates cabin status based on current bookings.
 */
const getCabinStatus = (cabinId, allBookings) => {
    const now = new Date();
    
    // Look for an Approved booking that is active (not completed, time remaining)
    const activeBooking = allBookings.find(b =>
        b.cabinId === cabinId &&
        b.status === 'Approved' &&
        !b.completionTime && 
        b.timestamp && 
        // Ensure timestamp is a valid Date object or can be converted to one for comparison
        (b.timestamp.getTime ? b.timestamp.getTime() : new Date(b.timestamp).getTime()) &&
        ((b.timestamp.getTime ? b.timestamp.getTime() : new Date(b.timestamp).getTime()) + BOOKING_DURATION_HOURS * 60 * 60 * 1000) > now.getTime()
    );

    if (activeBooking) {
        // Use the safe getTime method or fallback
        const startTime = activeBooking.timestamp.getTime ? activeBooking.timestamp.getTime() : new Date(activeBooking.timestamp).getTime();
        return { 
            status: 'Occupied', 
            name: activeBooking.requesterName, 
            endTime: startTime + BOOKING_DURATION_HOURS * 60 * 60 * 1000 
        };
    }

    const pendingBooking = allBookings.find(b =>
        b.cabinId === cabinId &&
        b.status === 'Pending'
    );

    if (pendingBooking) {
        return { status: 'Pending Approval', name: pendingBooking.requesterName };
    }

    return { status: 'Available', name: null };
};

// --- Core Components ---

/**
 * Animated Confirmation Modal
 */
const ConfirmationModal = ({ modal, setModal }) => {
    if (!modal) return null;

    const closeModal = () => setModal(null);
    const handleConfirm = () => {
        if (modal.action) modal.action();
        closeModal();
    };

    return (
        <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-sm flex justify-center items-center z-50 transition-all duration-300">
            <div className="bg-white text-gray-900 p-8 rounded-3xl shadow-2xl w-full max-w-md mx-4 border border-gray-100 animate-in fade-in zoom-in-95 duration-200">
                <h3 className="text-2xl font-bold text-gray-800 mb-3">{modal.title}</h3>
                <p className="text-gray-600 mb-8 leading-relaxed">{modal.message}</p>
                <div className="flex justify-end space-x-3">
                    <button 
                        onClick={closeModal} 
                        className="py-2.5 px-5 rounded-xl font-semibold bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors"
                    >
                        Cancel
                    </button>
                    <button 
                        onClick={handleConfirm} 
                        className="py-2.5 px-5 rounded-xl font-bold text-white bg-red-600 hover:bg-red-700 shadow-lg shadow-red-600/20 transition-all transform active:scale-95"
                    >
                        {modal.confirmText}
                    </button>
                </div>
            </div>
        </div>
    );
};

/**
 * Main Application Component
 */
const App = () => {
    // --- State Management ---
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [userId, setUserId] = useState(null);

    const [allBookings, setAllBookings] = useState([]);
    const [userBooking, setUserBooking] = useState(null);
    
    const [selectedCabinId, setSelectedCabinId] = useState('');
    const [selectedCapacity, setSelectedCapacity] = useState(0);
    const [groupMembers, setGroupMembers] = useState([]);
    
    const [capacityFilter, setCapacityFilter] = useState(''); 

    const [modal, setModal] = useState(null);
    const [alertUser, AlertComponent] = useAlert();


    // --- 1. Firebase Initialization and Authentication ---
    useEffect(() => {
        // Ensure firebaseConfig is valid before proceeding
        if (!firebaseConfig || !firebaseConfig.projectId) {
            // Only show warning if running outside Canvas (where __firebase_config is undefined)
            if (typeof __firebase_config === 'undefined') {
                 // Suppress alert for expected local setup failure if using the placeholder key
            } else {
                alertUser(<><XCircle className="w-5 h-5"/> <span>Firebase config missing.</span></>, 'bg-red-600 text-white');
            }
            return;
        }

        try {
            const app = initializeApp(firebaseConfig);
            const firestore = getFirestore(app);
            const auther = getAuth(app);
            
            setDb(firestore);
            setAuth(auther);

            const initAuth = async () => {
                if (initialAuthToken) {
                    await signInWithCustomToken(auther, initialAuthToken);
                } else {
                    // Fallback to anonymous sign-in
                    await signInAnonymously(auther);
                }
            };

            // Initialize auth flow
            initAuth().catch(error => {
                console.error("Auth failed:", error);
                alertUser(<><XCircle className="w-5 h-5"/> <span>Auth failed. Refresh page.</span></>, 'bg-red-600 text-white');
            });

            const unsubscribe = onAuthStateChanged(auther, (user) => {
                if (user) {
                    setUserId(user.uid);
                    setIsAuthReady(true);
                }
            });

            return () => unsubscribe();
        } catch (err) {
            console.error("Firebase init failed:", err);
            alertUser(<><XCircle className="w-5 h-5"/> <span>App Initialization Failed</span></>, 'bg-red-600 text-white');
        }
    }, [alertUser]);


    // --- 2. Realtime Firestore Listener ---
    useEffect(() => {
        // Ensure db, auth, and userId are ready before querying
        if (!db || !isAuthReady || !userId) return;

        // Use the dynamically built collection path
        const q = query(collection(db, BOOKINGS_COLLECTION));
        
        const unsubscribe = onSnapshot(q, (snapshot) => {
            const bookings = [];
            snapshot.forEach(doc => {
                const data = doc.data();
                const booking = { id: doc.id, ...data };
                
                // Convert Firestore Timestamps to JS Dates safely
                if (booking.timestamp && typeof booking.timestamp.toDate === 'function') {
                    booking.timestamp = booking.timestamp.toDate();
                } else if (typeof booking.timestamp === 'string' || typeof booking.timestamp === 'number') {
                     // Handle cases where timestamp might be stored as string (e.g., from export) or number
                     booking.timestamp = new Date(booking.timestamp);
                }
                
                if (booking.completionTime && typeof booking.completionTime.toDate === 'function') {
                    booking.completionTime = booking.completionTime.toDate();
                } else if (typeof booking.completionTime === 'string' || typeof booking.completionTime === 'number') {
                    booking.completionTime = new Date(booking.completionTime);
                }
                
                // Safety check: ensure timestamp is a valid Date object before adding
                if (booking.timestamp instanceof Date && !isNaN(booking.timestamp)) {
                    bookings.push(booking);
                } else {
                    console.warn("Skipping booking due to invalid timestamp:", booking);
                }

            });
            
            setAllBookings(bookings);
            
            // Find current user's active booking
            const now = new Date().getTime();
            const currentBooking = bookings.find(b => 
                b.requesterId === userId && 
                b.status === 'Approved' && 
                !b.completionTime && 
                // Check if the approved booking is still active based on duration
                (b.timestamp.getTime() + BOOKING_DURATION_HOURS * 60 * 60 * 1000) > now
            );
            
            // Also check for user's pending request
            const pendingRequest = bookings.find(b => 
                b.requesterId === userId && 
                b.status === 'Pending'
            );
            
            // User is considered 'active' if they have an approved, uncompleted booking OR a pending request
            setUserBooking(currentBooking || pendingRequest || null);

        }, (error) => {
            console.error("Error fetching bookings:", error);
            alertUser(<><XCircle className="w-5 h-5"/> <span>Connection error. Retrying...</span></>, 'bg-red-600 text-white');
        });

        return () => unsubscribe();
    }, [db, isAuthReady, userId, alertUser]);


    // --- 3. Booking Logic Functions ---

    /** Handles cabin card selection */
    const selectCabin = useCallback((cabinId, capacity) => {
        setSelectedCabinId(cabinId);
        setSelectedCapacity(capacity);
        
        // Initialize member inputs based on capacity. The first slot is for the Requester (host).
        setGroupMembers(new Array(capacity).fill('').map((_, i) => i === 0 ? '' : ''));

        // Scroll to the request form
        setTimeout(() => {
            document.getElementById('student-request-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 100); 
    }, []);

    /** Handles form submission */
    const submitBooking = useCallback(async () => {
        // User cannot submit a new request if they already have an active/pending booking
        if (!isAuthReady || userBooking) {
            alertUser(<><AlertTriangle className="w-5 h-5"/> <span>Active request or session exists. Wait for completion.</span></>, 'bg-amber-500 text-gray-900');
            return;
        }

        if (!selectedCabinId || selectedCapacity === 0) {
            alertUser(<><XCircle className="w-5 h-5"/> <span>Please select a cabin.</span></>, 'bg-red-600 text-white');
            return;
        }
        
        // Ensure the requester name (index 0) is filled
        const filledMembers = (groupMembers || []).map(name => (name || '').trim());
        
        if (!filledMembers[0]) {
             alertUser(<><XCircle className="w-5 h-5"/> <span>Primary Requester name is required.</span></>, 'bg-red-600 text-white');
             return;
        }

        // The number of required members is equal to the capacity (including the host)
        const requiredMembers = filledMembers.slice(0, selectedCapacity).filter(name => name.length > 0);
        if (requiredMembers.length < selectedCapacity) {
            alertUser(<><XCircle className="w-5 h-5"/> <span>All {selectedCapacity} member slots must be filled.</span></>, 'bg-red-600 text-white');
            return;
        }


        // Double-check availability before write
        if (getCabinStatus(selectedCabinId, allBookings).status !== 'Available') {
            alertUser(<><XCircle className="w-5 h-5"/> <span>Cabin taken! Please select another.</span></>, 'bg-red-600 text-white');
            return;
        }
        
        try {
            // Note: The timestamp here marks the request submission time, not the session start time.
            await addDoc(collection(db, BOOKINGS_COLLECTION), {
                cabinId: selectedCabinId,
                capacity: selectedCapacity,
                requesterName: filledMembers[0], // First member is requester
                requesterId: userId,
                groupMembers: requiredMembers, // Only store the names that were required/filled
                timestamp: Timestamp.now(),
                durationHours: BOOKING_DURATION_HOURS,
                status: 'Pending',
                approvedBy: null,
                completionTime: null,
            });
            
            // Cleanup UI
            setSelectedCabinId('');
            setSelectedCapacity(0);
            setGroupMembers([]);

            alertUser(<><CheckCircle className="w-5 h-5"/> <span>Request submitted for approval!</span></>, 'bg-emerald-600 text-white');
        } catch (error) {
            console.error("Submission error:", error);
            alertUser(<><XCircle className="w-5 h-5"/> <span>Submission failed.</span></>, 'bg-red-600 text-white');
        }
    }, [isAuthReady, userBooking, selectedCabinId, selectedCapacity, groupMembers, allBookings, alertUser, db, userId]);

    /** Handles booking cancellation (delete) */
    const cancelBooking = useCallback(async () => {
        if (!userBooking || !db) return;
        try {
            await deleteDoc(doc(db, BOOKINGS_COLLECTION, userBooking.id));
            alertUser(<><LogOut className="w-5 h-5"/> <span>Request cancelled.</span></>, 'bg-sky-600 text-white');
        } catch (error) {
            console.error("Cancel error:", error);
            alertUser(<><XCircle className="w-5 h-5"/> <span>Error cancelling request.</span></>, 'bg-red-600 text-white');
        }
    }, [userBooking, alertUser, db]);
    
    /** Handles early completion/check-out */
    const completeBookingEarly = useCallback(async () => {
        if (!userBooking || userBooking.status !== 'Approved' || !db) return;
        
        try {
            await updateDoc(doc(db, BOOKINGS_COLLECTION, userBooking.id), {
                status: 'Completed',
                completionTime: Timestamp.now(),
            });
            alertUser(<><CheckCircle className="w-5 h-5"/> <span>Checked out. Session complete.</span></>, 'bg-emerald-600 text-white');
        } catch (error) {
            console.error("Checkout error:", error);
            alertUser(<><XCircle className="w-5 h-5"/> <span>Checkout failed.</span></>, 'bg-red-600 text-white');
        }
    }, [userBooking, alertUser, db]);

    /** Confirmation triggers */
    const confirmCancelBooking = useCallback(() => {
        setModal({
            title: "Terminate Request?",
            message: userBooking.status === 'Approved' 
                     ? "This will immediately end your active session and free up the cabin."
                     : "This will permanently remove your pending booking request. You will need to start over.",
            confirmText: userBooking.status === 'Approved' ? "Yes, End Session" : "Yes, Terminate Request",
            action: cancelBooking,
        });
    }, [cancelBooking, userBooking]);
    
    const confirmCheckOut = useCallback(() => {
        setModal({
            title: "End Session Early?",
            message: "This will free up the cabin for other groups immediately.",
            confirmText: "Yes, Check Out",
            action: completeBookingEarly,
        });
    }, [completeBookingEarly]);
    
    /** Faculty Actions */
    const updateBookingStatus = useCallback(async (bookingId, newStatus) => {
        if (!isAuthReady || !db) return;
        
        // Simplified Admin: any logged-in user can perform admin actions for this demo
        const facultyName = `Admin (${userId.substring(0, 4)})`; 
        const updateData = { status: newStatus };

        if (newStatus === 'Approved') {
            updateData.approvedBy = facultyName;
            // The official session timer starts *now* upon approval
            updateData.timestamp = Timestamp.now(); 
            // Ensure no completion time is set if approving
            updateData.completionTime = null;
        } else if (newStatus === 'Rejected') {
            // Rejection usually implies deletion, but we keep the record with a status
            // Optionally, you might delete the document here instead of updating the status
        }
        else if (newStatus === 'Completed') {
            updateData.completionTime = Timestamp.now();
        }

        try {
            await updateDoc(doc(db, BOOKINGS_COLLECTION, bookingId), updateData);
        } catch (error) {
            console.error("Update error:", error);
            alertUser(<><XCircle className="w-5 h-5"/> <span>Action failed.</span></>, 'bg-red-600 text-white');
        }
    }, [isAuthReady, db, userId, alertUser]);


    // --- 4. Timer Hook (For User Status Card) ---
    const useCountdown = (booking) => {
        const [remainingTime, setRemainingTime] = useState(null);
        const [isCritical, setIsCritical] = useState(false);

        useEffect(() => {
            // Dependencies for the timer: must run when booking changes
            if (!booking || booking.status !== 'Approved' || booking.completionTime || !booking.timestamp) {
                setRemainingTime(null);
                return;
            }

            // Safe access to getTime
            const startTime = booking.timestamp.getTime ? booking.timestamp.getTime() : new Date(booking.timestamp).getTime();

            const updateTimer = () => {
                const endTime = startTime + booking.durationHours * 60 * 60 * 1000;
                const now = new Date().getTime();
                const distance = endTime - now;

                if (distance < 0) {
                    setRemainingTime('EXPIRED');
                    // Automatically trigger 'Completed' status if expired
                    // Use a timeout to prevent infinite loops if the update fails
                    if (booking.id && booking.status === 'Approved') {
                        setTimeout(() => updateBookingStatus(booking.id, 'Completed'), 500); 
                    }
                    setIsCritical(false);
                } else {
                    const minutesLeft = Math.floor(distance / (1000 * 60));
                    setIsCritical(minutesLeft <= 10); // Critical is now 10 mins

                    const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                    const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
                    const seconds = Math.floor((distance % (1000 * 60)) / 1000);
                    setRemainingTime(`${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`);
                }
            };

            updateTimer(); // Immediate call
            const interval = setInterval(updateTimer, 1000);
            return () => clearInterval(interval);
        }, [booking, updateBookingStatus]);

        return { remainingTime, isCritical };
    };


    // --- 5. Rendering Components ---

    const filteredCabins = useMemo(() => {
        let list = initialCabins;
        if (capacityFilter) {
            list = list.filter(c => c.capacity === parseInt(capacityFilter));
        }
        return list;
    }, [capacityFilter]);

    // Renders the list of cabins
    const CabinGrid = useMemo(() => {
        return filteredCabins.map(cabin => {
            const statusInfo = getCabinStatus(cabin.id, allBookings);
            const isAvailable = statusInfo.status === 'Available';
            const isOccupied = statusInfo.status === 'Occupied';
            const isSelected = selectedCabinId === cabin.id;
            
            let statusText, statusIcon, borderColor;
            
            if (isAvailable) {
                statusText = 'Available';
                statusIcon = <CheckCircle className="w-5 h-5 text-emerald-600 mr-2"/>;
                borderColor = isSelected ? 'border-amber-500 ring-2 ring-amber-200' : 'border-emerald-400/30';
            } else if (statusInfo.status === 'Pending Approval') {
                statusText = 'Pending Approval';
                statusIcon = <Clock className="w-5 h-5 text-amber-600 mr-2"/>;
                borderColor = 'border-amber-400/50';
            } else {
                // Occupied
                statusText = (
                    <TimerDisplay 
                        endTime={statusInfo.endTime} 
                        durationHours={BOOKING_DURATION_HOURS}
                    />
                );
                statusIcon = <XCircle className="w-5 h-5 text-red-600 mr-2"/>;
                borderColor = 'border-red-400/50';
            }

            // Disabled if occupied, pending, or if the user already has a pending/active booking
            const isDisabled = !isAvailable || !!userBooking;
            
            return (
                <div 
                    key={cabin.id}
                    className={`
                        relative p-5 bg-white rounded-2xl shadow-sm transition-all duration-300 
                        border-2 ${borderColor}
                        ${isSelected ? `shadow-lg scale-[1.02] border-4` : ''}
                        ${isDisabled ? 'opacity-70 grayscale-[0.3]' : 'hover:shadow-md hover:-translate-y-1 cursor-pointer'}
                    `}
                    onClick={!isDisabled ? () => selectCabin(cabin.id, cabin.capacity) : undefined}
                >
                    <div className="flex justify-between items-start mb-2">
                        <h3 className="text-xl font-bold text-gray-800">{cabin.name}</h3>
                        <div className="bg-indigo-50 text-indigo-600 p-1.5 rounded-lg">
                            <Users className="w-4 h-4"/>
                        </div>
                    </div>
                    
                    <div className="flex items-center text-sm text-gray-500 mb-4">
                        <span className="font-medium">{cabin.capacity} Seats</span>
                    </div>

                    <div className="flex items-center text-sm font-semibold mb-2">
                         {isOccupied ? <Clock className="w-5 h-5 text-red-600 mr-2"/> : statusIcon}
                         <span className={`${isOccupied ? 'text-red-600 text-sm' : isAvailable ? 'text-emerald-600' : 'text-amber-600'}`}>
                            {statusText}
                         </span>
                    </div>

                    {statusInfo.name && (
                        <div className="text-xs bg-gray-100 p-2 rounded-lg text-gray-600 truncate">
                            Host: {statusInfo.name}
                        </div>
                    )}
                    
                    <button 
                        className={`
                            mt-4 w-full py-2 rounded-lg font-bold text-sm transition-colors
                            ${isSelected ? 'bg-amber-500 text-white shadow-md shadow-amber-300' : 
                              isDisabled ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 
                              'bg-indigo-500 text-white hover:bg-indigo-600'}
                        `}
                        disabled={isDisabled}
                    >
                        {isSelected ? 'Selected' : isAvailable ? 'Select' : 'Unavailable'}
                    </button>
                </div>
            );
        });
    }, [selectedCabinId, allBookings, userBooking, selectCabin, filteredCabins]);
    
    // Timer component for occupied cabins in the grid
    const TimerDisplay = ({ endTime }) => {
        const [timeRemaining, setTimeRemaining] = useState('00:00');

        useEffect(() => {
            const calculateTime = () => {
                const now = new Date().getTime();
                const distance = endTime - now;

                if (distance <= 0) {
                    setTimeRemaining('Expired');
                    return;
                }

                const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
                const seconds = Math.floor((distance % (1000 * 60)) / 1000);
                
                setTimeRemaining(`${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`);
            };

            calculateTime();
            const interval = setInterval(calculateTime, 1000);
            return () => clearInterval(interval);
        }, [endTime]);

        return <span>Ends in {timeRemaining}</span>;
    };


    const UserStatusCard = () => {
        const { remainingTime, isCritical } = useCountdown(userBooking);

        if (!userBooking) {
            return (
                <div className="p-8 bg-white border-2 border-dashed border-gray-300 rounded-2xl text-center shadow-lg">
                    <BookOpen className="w-10 h-10 mx-auto text-gray-400 mb-3"/>
                    <h3 className="text-lg font-semibold text-gray-700">No Active Sessions</h3>
                    <p className="text-sm text-gray-500">Select a cabin below to start booking.</p>
                </div>
            );
        }
        
        const isApproved = userBooking.status === 'Approved';
        const isPending = userBooking.status === 'Pending';
        const statusColor = isApproved ? 'bg-emerald-500' : 'bg-amber-500';

        return (
            <div className="bg-white border-l-4 border-indigo-600 rounded-r-2xl shadow-lg overflow-hidden">
                <div className="p-6 sm:p-8">
                    <div className="flex justify-between items-start mb-6">
                        <div>
                            <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-bold text-white mb-2 ${statusColor}`}>
                                {isApproved ? <CheckCircle className="w-3 h-3 mr-1"/> : <Clock className="w-3 h-3 mr-1"/>}
                                {userBooking.status.toUpperCase()}
                            </span>
                            <h2 className="text-3xl font-bold text-gray-900">
                                {userBooking.cabinId} 
                                <span className="text-lg font-normal text-gray-500 ml-2">({userBooking.capacity} Pax)</span>
                            </h2>
                        </div>
                        {isApproved && (
                            <div className={`text-right ${isCritical ? 'animate-pulse' : ''}`}>
                                <p className="text-xs text-gray-500 font-bold uppercase tracking-wider">Time Remaining</p>
                                <div className={`text-3xl font-mono font-bold ${isCritical ? 'text-red-600' : 'text-emerald-600'}`}>
                                    {remainingTime || '--:--'}
                                </div>
                            </div>
                        )}
                        {isPending && (
                             <div className="text-right">
                                <p className="text-sm text-gray-500 font-bold uppercase tracking-wider">Requested At</p>
                                <div className="text-xl font-bold text-amber-600">
                                    {userBooking.timestamp?.toLocaleTimeString ? userBooking.timestamp.toLocaleTimeString() : 'N/A'}
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="bg-gray-50 rounded-xl p-4 mb-6">
                        <h4 className="text-xs font-bold uppercase text-gray-500 mb-2">Group Members ({userBooking.groupMembers.length}/{userBooking.capacity})</h4>
                        <div className="grid grid-cols-2 gap-4">
                            {(userBooking.groupMembers || []).map((name, i) => (
                                <div key={i} className="flex items-center text-sm text-gray-700 truncate">
                                    <div className={`w-2 h-2 rounded-full mr-2 ${i===0 ? 'bg-indigo-500' : 'bg-gray-400'}`}></div>
                                    <span className={i===0 ? 'font-semibold' : ''}>{name} {i===0 && '(Host)'}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="flex gap-3">
                        {isApproved && (
                            <button 
                                onClick={confirmCheckOut}
                                className="flex-1 py-3 px-4 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 font-bold rounded-xl transition-colors flex items-center justify-center"
                            >
                                <LogOut className="w-4 h-4 mr-2"/> Check Out
                            </button>
                        )}
                        <button 
                            onClick={confirmCancelBooking}
                            className={`
                                py-3 px-4 bg-gray-100 hover:bg-red-50 text-gray-600 hover:text-red-600 font-bold rounded-xl transition-colors flex items-center justify-center
                                ${!isApproved ? 'w-full' : 'flex-1'}
                            `}
                        >
                            Cancel Request
                        </button>
                    </div>
                </div>
            </div>
        );
    };

    const FacultyView = useMemo(() => {
        const active = allBookings
            .filter(b => b.status === 'Pending' || b.status === 'Approved')
            // Sort by status (Pending first) and then by request time
            .sort((a, b) => {
                // Pending (0) vs Approved (1)
                const statusOrderA = a.status === 'Pending' ? 0 : 1;
                const statusOrderB = b.status === 'Pending' ? 0 : 1;

                if (statusOrderA !== statusOrderB) {
                    return statusOrderA - statusOrderB;
                }

                // Sort by timestamp if statuses are the same
                const timeA = a.timestamp?.getTime ? a.timestamp.getTime() : 0;
                const timeB = b.timestamp?.getTime ? b.timestamp.getTime() : 0;
                return timeA - timeB;
            });

        if (active.length === 0) return <div className="text-center text-gray-400 py-8 text-sm">No active requests or sessions in the queue.</div>;

        return active.map(b => (
            <div key={b.id} className="flex flex-col sm:flex-row justify-between items-center p-4 bg-white border border-gray-100 rounded-xl shadow-sm mb-3 hover:shadow-md transition-shadow">
                <div className="mb-3 sm:mb-0 w-full sm:w-auto">
                    <div className="flex items-center gap-2 mb-1">
                        <span className={`w-2 h-2 rounded-full ${b.status === 'Pending' ? 'bg-amber-500' : 'bg-emerald-500'}`}></span>
                        <span className="font-bold text-gray-800">{b.cabinId} ({b.capacity} Pax)</span>
                    </div>
                    <div className="text-sm text-gray-500 pl-4">
                        Host: {b.requesterName}
                    </div>
                    <div className="text-xs text-gray-400 pl-4">
                        {b.status === 'Pending' ? 'Requested' : 'Started'}: {b.timestamp?.toLocaleTimeString ? b.timestamp.toLocaleTimeString() : 'N/A'}
                    </div>
                </div>
                
                <div className="flex gap-2 w-full sm:w-auto">
                    {b.status === 'Pending' ? (
                        <>
                            <button onClick={() => updateBookingStatus(b.id, 'Approved')} className="flex-1 sm:flex-none py-1.5 px-3 bg-emerald-100 text-emerald-700 rounded-lg text-sm font-semibold hover:bg-emerald-200">Approve</button>
                            <button onClick={() => updateBookingStatus(b.id, 'Rejected')} className="flex-1 sm:flex-none py-1.5 px-3 bg-red-100 text-red-700 rounded-lg text-sm font-semibold hover:bg-red-200">Reject</button>
                        </>
                    ) : (
                        <button onClick={() => updateBookingStatus(b.id, 'Completed')} className="w-full sm:w-auto py-1.5 px-3 bg-gray-100 text-gray-600 rounded-lg text-sm font-semibold hover:bg-gray-200">Force Complete</button>
                    )}
                </div>
            </div>
        ));
    }, [allBookings, updateBookingStatus, userId]);

    // CSV Export
    const exportCSV = () => {
        if (!allBookings.length) {
             alertUser(<><AlertTriangle className="w-5 h-5"/> <span>No data to export.</span></>, 'bg-amber-500 text-gray-900');
             return;
        }
        
        const headers = ["ID","Cabin","Capacity","Status","Requester","RequesterID","GroupMembers","DurationHours","Timestamp","CompletionTime","ApprovedBy"];
        
        // Filter out any bookings with invalid dates (shouldn't happen with the listener fix, but safe)
        const validBookings = allBookings.filter(b => b.timestamp instanceof Date && !isNaN(b.timestamp));

        const rows = validBookings.map(b => {
             // Convert dates to ISO strings for consistent export, or empty string if not present
             const timeStr = b.timestamp?.toISOString ? b.timestamp.toISOString() : '';
             const completionStr = b.completionTime?.toISOString ? b.completionTime.toISOString() : '';
             
             // Escape commas in member list by enclosing in double quotes (standard CSV practice)
             const membersStr = `"${(b.groupMembers || []).join('; ')}"`; 
             
             // Escape the requester name, too
             const requesterNameStr = `"${b.requesterName}"`;

             return [
                 b.id,
                 b.cabinId,
                 b.capacity,
                 b.status,
                 requesterNameStr,
                 b.requesterId,
                 membersStr,
                 b.durationHours,
                 timeStr,
                 completionStr,
                 b.approvedBy || ''
             ].join(',');
        });
        
        // Join header and rows, then ensure lines are properly terminated
        const csvContent = headers.join(',') + '\n' + rows.join('\n');
        
        // Create and trigger download
        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([csvContent], { type: 'text/csv;charset=utf-8;' }));
        link.download = `bookings-export-${new Date().toISOString().split('T')[0]}.csv`;
        link.click();
        
        alertUser(<><Download className="w-5 h-5"/> <span>Export started!</span></>, 'bg-indigo-600 text-white');
    };

    return (
        <div className="min-h-screen bg-slate-50 text-slate-900 pb-20">
            <AlertComponent />
            <ConfirmationModal modal={modal} setModal={setModal} />

            {/* Header */}
            <header className="bg-indigo-600 text-white pt-12 pb-24 px-4 sm:px-8 shadow-xl">
                <div className="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-end">
                    <div>
                        <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight">CabinControl</h1>
                        <p className="text-indigo-200 mt-2">Campus Study Space Management</p>
                    </div>
                    <div className="text-right mt-4 sm:mt-0">
                        <div className="text-xs font-mono bg-indigo-700/50 px-3 py-1 rounded-full text-indigo-200">
                            User ID: {userId ? userId.substring(0, 8) + '...' : 'Connecting...'}
                        </div>
                    </div>
                </div>
            </header>

            <main className="max-w-7xl mx-auto px-4 sm:px-8 -mt-16 space-y-12">
                
                {/* 1. Status Section */}
                <section>
                    <UserStatusCard />
                </section>

                {/* 2. Selection Section */}
                <section>
                    <div className="flex flex-col sm:flex-row justify-between items-end mb-6 border-b border-gray-200 pb-4">
                        <div>
                            <h2 className="text-2xl font-bold text-gray-800">Available Spaces</h2>
                            <p className="text-gray-500">Select a cabin to view details</p>
                        </div>
                        <div className="mt-4 sm:mt-0 relative">
                            <Filter className="w-4 h-4 text-gray-500 absolute left-3 top-3.5 pointer-events-none"/>
                            <select 
                                value={capacityFilter}
                                onChange={(e) => setCapacityFilter(e.target.value)}
                                className="pl-9 pr-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium focus:ring-2 focus:ring-indigo-500 outline-none shadow-sm appearance-none"
                            >
                                <option value="">All Capacities</option>
                                <option value="4">4 Person</option>
                                <option value="5">5 Person</option>
                                <option value="6">6 Person</option>
                            </select>
                            <svg className="w-4 h-4 text-gray-500 absolute right-3 top-3.5 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                        </div>
                    </div>
                    
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
                        {CabinGrid}
                    </div>
                </section>

                {/* 3. Booking Form (Only visible if cabin selected and no active booking) */}
                {selectedCabinId && !userBooking && (
                    <section id="student-request-form" className="animate-in slide-in-from-bottom-10 fade-in duration-500">
                        <div className="bg-white rounded-2xl shadow-xl border border-gray-100 p-8 max-w-3xl mx-auto">
                            <div className="flex items-center gap-4 mb-8">
                                <div className="p-3 bg-amber-100 text-amber-600 rounded-xl">
                                    <Zap className="w-6 h-6"/>
                                </div>
                                <div>
                                    <h2 className="text-2xl font-bold text-gray-900">Finalize Request</h2>
                                    <p className="text-gray-500">Booking <span className="font-bold text-gray-900">{selectedCabinId}</span> for {BOOKING_DURATION_HOURS} hours (Capacity: {selectedCapacity})</p>
                                </div>
                            </div>

                            <div className="space-y-4 mb-8">
                                {Array.from({ length: selectedCapacity }).map((_, idx) => (
                                    <div key={idx} className="group">
                                        <label className="block text-xs font-bold text-gray-500 uppercase mb-1 ml-1">
                                            {idx === 0 ? 'Primary Requester (Your Name)' : `Group Member ${idx + 1}`}
                                        </label>
                                        <input 
                                            type="text"
                                            value={groupMembers[idx] || ''} // Ensure value is controlled
                                            onChange={(e) => {
                                                const newM = [...groupMembers];
                                                newM[idx] = e.target.value;
                                                setGroupMembers(newM);
                                            }}
                                            placeholder={idx === 0 ? "Your Full Name" : "Group Member Full Name"}
                                            className="w-full p-3 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                                        />
                                    </div>
                                ))}
                            </div>

                            <button 
                                onClick={submitBooking}
                                className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl shadow-lg shadow-indigo-200 transition-all transform active:scale-[0.99]"
                            >
                                Submit Request
                            </button>
                        </div>
                    </section>
                )}

                {/* 4. Admin Panel */}
                <section className="bg-white rounded-2xl p-8 border border-gray-200">
                    <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6">
                        <h3 className="text-lg font-bold text-gray-800 flex items-center mb-4 sm:mb-0">
                            <Users className="w-5 h-5 mr-2 text-indigo-500"/> 
                            Admin Queue (Pending & Active Sessions)
                        </h3>
                        <button onClick={exportCSV} className="text-sm text-indigo-600 hover:text-indigo-800 font-medium flex items-center py-2 px-3 border border-indigo-200 rounded-lg bg-indigo-50 hover:bg-indigo-100 transition-colors">
                            <Download className="w-4 h-4 mr-1"/> Export All Data (.csv)
                        </button>
                    </div>
                    <div className="space-y-3">
                        {FacultyView}
                    </div>
                </section>

            </main>
        </div>
    );
};

export default App;