import {useEffect,useState} from 'react'
import ActionNotice from './ActionNotice'
import {List} from 'lucide-react'
import {Dropdown} from '../components/AppPrimitives'
import {apiGet} from '../api/client'

export default function CompoundNameInput({value,disabled,onChange}) {
  const [choices,setChoices]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState('')
  useEffect(()=>{setChoices([]);setError('')},[value])
  async function names(){
    setBusy(true);setError('')
    try{const data=await apiGet(`/lab/compound-names?name=${encodeURIComponent(value)}`);setChoices(data.choices||[]);if(!data.choices?.length)setError('No alternative names returned. You can enter the compound name directly.')}
    catch(e){setError(e.message)}finally{setBusy(false)}
  }
  return <><input aria-label="Compound" type="text" value={value} disabled={disabled||busy} onChange={e=>onChange(e.target.value)}/>
    <button type="button" className="ghost-button" disabled={disabled||busy||!value.trim()} onClick={names}><List size={16}/>{busy?'Loading names...':'Alternative names'}</button>
    {!!choices.length&&<Dropdown aria-label="Alternative compound names" value="" disabled={disabled} menuPortal options={[{value:'',label:'Choose a compound name'},...choices.map(name=>({value:name,label:name}))]} onChange={name=>{if(name)onChange(name)}}/>}
    {error&&<ActionNotice error>{error}</ActionNotice>}
  </>
}
