import { render } from 'solid-js/web';
import App from './App.tsx';
import './styles.css';
import './contrast.css';
const root = document.getElementById('root');
if (!root) throw new Error('Office mount point missing');
render(() => <App/>, root);
